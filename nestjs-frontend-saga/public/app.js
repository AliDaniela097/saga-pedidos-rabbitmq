'use strict';

/* ============================================================
   SagaPedidos - lógica de la página.
   Flujo: esta página -> API del frontend (/api) -> RabbitMQ -> servicios.
   La página consulta /api cada 2 segundos (cada 8 si no hay pedidos en proceso).
   ============================================================ */

// ---------- Textos que ve el usuario ----------

const AYUDA_MODO = {
  coreografiada:
    'Cada servicio reacciona a eventos y nadie dirige. El pedido responde enseguida y el resultado aparece unos instantes después.',
  orquestada:
    'Un orquestador llama a Inventario, Pago y Notificaciones en orden y decide la compensación si algo falla.',
};

// Cada evento de traza se muestra con una frase clara.
const TEXTO_EVENTO = {
  PedidoCreado: 'Se creó el pedido',
  InventarioReservado: 'Inventario reservó el stock',
  InventarioRechazado: 'Inventario rechazó el pedido',
  PagoProcesado: 'El pago fue aprobado',
  PagoFallido: 'El pago falló (simulado)',
  InventarioLiberado: 'Inventario devolvió el stock (compensación)',
  PedidoCancelado: 'El pedido quedó cancelado',
  PedidoConfirmado: 'Notificaciones confirmó el pedido al cliente',
  OrqReservarInventario: 'El orquestador pidió reservar el inventario',
  OrqProcesarPago: 'El orquestador pidió procesar el pago',
  OrqCompensarInventario: 'El orquestador ordenó liberar el inventario',
  OrqNotificar: 'El orquestador pidió notificar',
  PedidoRechazado: 'El orquestador rechazó el pedido',
  CompensacionPendiente: 'No se pudo devolver el stock: queda pendiente de revisar',
  NotificacionFallida: 'No se pudo notificar al cliente',
};

const CLASE_ESTADO = {
  Confirmado: 'ok',
  Cancelado: 'mal',
  Rechazado: 'aviso',
  'En proceso': 'info',
  'Pagado sin notificar': 'raro',
  'Compensación pendiente': 'raro',
};

const FILTROS = ['Todos', 'En proceso', 'Confirmado', 'Cancelado', 'Rechazado'];

// ---------- Estado de la página ----------

let productos = [];
let pedidos = [];
let filtroActual = 'Todos';
const abiertos = new Set(); // pedidos con el recorrido desplegado
let firmaProductos = '';
let firmaPedidos = '';
let temporizadorAviso = null;
let servicios = [];
let firmaServicios = '';
let ultimaActividad = Date.now();
let pausado = false;
let ultimoDespertar = 0;
let manual = false; // el usuario pausó la actualización automática
const propios = new Set(); // pedidos creados desde esta página
const estadosVistos = new Map();

// Para no gastar las horas del plan gratis: sin actividad se pausa la consulta automática.
const MINUTOS_SIN_ACTIVIDAD = 20;
const MINUTOS_ENTRE_DESPERTARES = 4; // menos de los 15 min en que se duermen

// ---------- Utilidades ----------

const $ = (id) => document.getElementById(id);

// Crea un elemento. El texto se asigna con textContent, nunca como HTML.
function el(etiqueta, opciones = {}, hijos = []) {
  const nodo = document.createElement(etiqueta);
  if (opciones.clase) nodo.className = opciones.clase;
  if (opciones.texto !== undefined) nodo.textContent = opciones.texto;
  if (opciones.atributos) {
    for (const [clave, valor] of Object.entries(opciones.atributos)) {
      nodo.setAttribute(clave, valor);
    }
  }
  for (const hijo of [].concat(hijos)) {
    if (hijo) nodo.appendChild(hijo);
  }
  return nodo;
}

async function api(ruta, opciones) {
  let respuesta;
  try {
    respuesta = await fetch('/api' + ruta, opciones);
  } catch (e) {
    throw new Error('No hay conexión con el servidor. Revisa tu red e inténtalo de nuevo.');
  }
  let cuerpo = null;
  try {
    cuerpo = await respuesta.json();
  } catch (e) {
    /* la respuesta no trae JSON */
  }
  if (!respuesta.ok) {
    const mensaje = cuerpo && cuerpo.message ? [].concat(cuerpo.message).join(', ') : 'Error ' + respuesta.status;
    throw new Error(mensaje);
  }
  return cuerpo;
}

function enviar(ruta, datos) {
  return api(ruta, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(datos),
  });
}

// Los éxitos se anuncian y desaparecen solos; los errores (role="alert") se quedan hasta cerrarlos.
function mostrarAviso(texto, tipo) {
  if (tipo === 'mal') {
    $('textoError').textContent = texto;
    $('avisoError').hidden = false;
    return;
  }
  const aviso = $('aviso');
  aviso.textContent = texto;
  clearTimeout(temporizadorAviso);
  temporizadorAviso = setTimeout(() => { aviso.textContent = ''; }, 6000);
}

// Error junto al formulario, enlazado a sus campos con aria-describedby.
function errorForm(idMensaje, idForm, texto) {
  $(idMensaje).textContent = texto ? 'Error: ' + texto : '';
  for (const campo of $(idForm).querySelectorAll('input, select')) {
    if (texto) campo.setAttribute('aria-describedby', idMensaje);
    else campo.removeAttribute('aria-describedby');
  }
}

// Redibuja una lista sin que el teclado pierda su lugar: recuerda qué control tenía el foco.
function conservandoFoco(contenedor, pintar) {
  const clave = contenedor.contains(document.activeElement) ? document.activeElement.dataset.foco : null;
  pintar();
  if (clave) {
    const nuevo = contenedor.querySelector('[data-foco="' + clave + '"]');
    if (nuevo) nuevo.focus();
  }
}

// Mientras se escribe en un campo de una lista, no se redibuja (se perdería lo escrito).
function editando() {
  const a = document.activeElement;
  return !!a && (a.tagName === 'INPUT' || a.tagName === 'SELECT') && !!(a.closest('#grillaProductos') || a.id === 'selProducto');
}

function hora(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

function claseDePaso(status) {
  if (status === 'compensated' || status === 'cancelled') return 'comp';
  if (status === 'error' || status === 'rejected') return 'mal';
  return 'ok';
}

// ---------- Productos ----------

function tarjetaProducto(p) {
  const [textoEstado, claseEstado] =
    p.stock === 0 ? ['Sin stock', 'mal'] : p.stock <= 3 ? ['Poco stock', 'aviso'] : ['Disponible', 'ok'];

  const entrada = el('input', {
    clase: 'mini',
    atributos: { type: 'number', min: '1', max: '100000', value: '5', 'aria-label': 'Cantidad a reponer de ' + p.nombre },
  });
  const boton = el('button', {
    clase: 'btn btn-claro btn-chico',
    texto: 'Reponer',
    atributos: { type: 'button', 'data-foco': 'rep-' + p.id, 'aria-label': 'Reponer stock de ' + p.nombre },
  });
  boton.addEventListener('click', async () => {
    if (boton.getAttribute('aria-busy') === 'true') return; // sin disabled: así el foco no se pierde
    boton.setAttribute('aria-busy', 'true');
    try {
      await enviar('/productos/' + p.id + '/reponer', { cantidad: Number(entrada.value) });
      mostrarAviso('Stock repuesto: ' + p.nombre);
      await refrescar();
    } catch (e) {
      mostrarAviso(e.message, 'mal');
    } finally {
      boton.removeAttribute('aria-busy');
    }
  });

  return el('article', { clase: 'tarjeta producto' }, [
    el('div', {}, [
      el('div', { clase: 'producto-nombre', texto: p.nombre }),
      el('div', { clase: 'producto-id', texto: 'Producto #' + p.id }),
    ]),
    el('div', { clase: 'producto-stock' }, [
      el('strong', { texto: String(p.stock) }),
      el('span', { texto: 'en stock' }),
    ]),
    el('div', {}, [el('span', { clase: 'insignia ' + claseEstado, texto: textoEstado })]),
    el('div', { clase: 'reponer' }, [entrada, boton]),
  ]);
}

function pintarProductos() {
  const grilla = $('grillaProductos');
  conservandoFoco(grilla, () => {
    grilla.replaceChildren();
    if (productos.length === 0) {
      grilla.appendChild(el('p', { clase: 'vacio', texto: 'Todavía no hay productos. Crea el primero.' }));
    }
    for (const p of productos) grilla.appendChild(tarjetaProducto(p));
  });

  // La lista desplegable del pedido conserva el producto elegido.
  const selector = $('selProducto');
  const elegido = selector.value;
  selector.replaceChildren();
  for (const p of productos) {
    const opcion = el('option', { texto: p.nombre + ' (stock ' + p.stock + ')', atributos: { value: String(p.id) } });
    selector.appendChild(opcion);
  }
  if (elegido && productos.some((p) => String(p.id) === elegido)) selector.value = elegido;
}

// ---------- Pedidos ----------

function pintarFiltros() {
  const contenedor = $('filtros');
  conservandoFoco(contenedor, () => llenarFiltros(contenedor));
}

function llenarFiltros(contenedor) {
  contenedor.replaceChildren();
  for (const nombre of FILTROS) {
    const cantidad = nombre === 'Todos' ? pedidos.length : pedidos.filter((p) => p.estado === nombre).length;
    const boton = el('button', {
      clase: 'filtro' + (nombre === filtroActual ? ' on' : ''),
      texto: nombre + ' (' + cantidad + ')',
      atributos: { type: 'button', 'aria-pressed': String(nombre === filtroActual), 'data-foco': 'flt-' + nombre },
    });
    boton.addEventListener('click', () => {
      filtroActual = nombre;
      pintarFiltros();
      pintarPedidos();
    });
    contenedor.appendChild(boton);
  }
}

function recorrido(pedido) {
  const lista = el('ol', { clase: 'linea' });
  const inicio = pedido.pasos.length ? new Date(pedido.pasos[0].timestamp).getTime() : 0;
  for (const paso of pedido.pasos) {
    const transcurrido = new Date(paso.timestamp).getTime() - inicio;
    const meta = [
      el('span', { clase: 'servicio', texto: paso.service }),
      el('span', { clase: 'paso-tiempo', texto: hora(paso.timestamp) + '  (+' + (Number.isFinite(transcurrido) ? transcurrido : 0) + ' ms)' }),
    ];
    if (paso.detalle) meta.push(el('span', { texto: paso.detalle }));
    lista.appendChild(
      el('li', { clase: 'paso ' + claseDePaso(paso.status) }, [
        el('span', { clase: 'paso-punto', atributos: { 'aria-hidden': 'true' } }),
        el('div', { clase: 'paso-titulo', texto: TEXTO_EVENTO[paso.event] || paso.event }),
        el('div', { clase: 'paso-meta' }, meta),
      ])
    );
  }
  if (pedido.pasos.length === 0) {
    lista.appendChild(el('li', { clase: 'vacio', texto: 'Todavía no llegó ningún evento.' }));
  }
  return el('div', { clase: 'recorrido' }, [
    el('p', { clase: 'recorrido-titulo', texto: 'Recorrido del pedido (mismo correlation_id en todos los pasos)' }),
    lista,
  ]);
}

function tarjetaPedido(pedido) {
  const abierto = abiertos.has(pedido.pedidoId);
  const titulo = pedido.productoNombre
    ? pedido.productoNombre + ' × ' + pedido.cantidad
    : 'Pedido creado fuera de la interfaz';
  const boton = el('button', {
    clase: 'btn btn-claro btn-chico',
    texto: abierto ? 'Ocultar recorrido' : 'Ver recorrido',
    atributos: { type: 'button', 'aria-expanded': String(abierto), 'data-foco': 'alt-' + pedido.pedidoId },
  });
  boton.addEventListener('click', () => {
    if (abiertos.has(pedido.pedidoId)) abiertos.delete(pedido.pedidoId);
    else abiertos.add(pedido.pedidoId);
    pintarPedidos();
  });

  const cabecera = el('div', { clase: 'pedido-cabecera' }, [
    el('span', { clase: 'pedido-id', texto: pedido.pedidoId }),
    el('div', { clase: 'pedido-detalle' }, [
      document.createTextNode(titulo),
      el('small', { texto: 'Hora ' + hora(pedido.creadoEn) }),
    ]),
    el('span', { clase: 'insignia neutro', texto: pedido.modo === 'orquestada' ? 'Orquestada' : 'Coreografiada' }),
    el('span', { clase: 'insignia ' + (CLASE_ESTADO[pedido.estado] || 'neutro'), texto: pedido.estado }),
    boton,
  ]);

  return el('article', { clase: 'tarjeta pedido' }, [cabecera, abierto ? recorrido(pedido) : null]);
}

function pintarPedidos() {
  const lista = $('listaPedidos');
  conservandoFoco(lista, () => {
    lista.replaceChildren();
    const visibles = pedidos.filter((p) => filtroActual === 'Todos' || p.estado === filtroActual);
    if (visibles.length === 0) {
      lista.appendChild(
        el('p', { clase: 'vacio', texto: pedidos.length === 0 ? 'Todavía no hay pedidos. Crea el primero arriba.' : 'No hay pedidos con ese estado.' })
      );
      return;
    }
    for (const pedido of visibles) lista.appendChild(tarjetaPedido(pedido));
  });
}

function pintarCifras() {
  $('cifraTotal').textContent = String(pedidos.length);
  $('cifraOk').textContent = String(pedidos.filter((p) => p.estado === 'Confirmado').length);
  $('cifraMal').textContent = String(pedidos.filter((p) => p.estado === 'Cancelado').length);
}

// ---------- Servicios en la nube ----------

const TEXTO_SERVICIO = { activo: 'Activo', despertando: 'Despertando…', 'sin respuesta': 'Dormido o sin respuesta' };

function pintarServicios() {
  const panel = $('panelServicios');
  panel.hidden = servicios.length === 0; // en local no hay servicios que vigilar
  const lista = $('listaServicios');
  lista.replaceChildren();
  for (const s of servicios) {
    lista.appendChild(
      el('span', { clase: 'chip-servicio ' + s.estado.split(' ')[0] }, [
        el('i', { atributos: { 'aria-hidden': 'true' } }),
        document.createTextNode(s.nombre),
        el('small', { texto: TEXTO_SERVICIO[s.estado] || s.estado }),
      ])
    );
  }
}

async function despertar() {
  ultimoDespertar = Date.now();
  try {
    servicios = await enviar('/servicios/despertar', {});
    firmaServicios = JSON.stringify(servicios);
    pintarServicios();
  } catch (e) {
    mostrarAviso(e.message, 'mal');
  }
}

function pausar() {
  pausado = true;
  $('bannerPausa').hidden = false;
}

function reanudar() {
  pausado = false;
  ultimaActividad = Date.now();
  $('bannerPausa').hidden = true;
  if (servicios.length > 0) despertar();
  refrescar();
}

// ---------- Actualización periódica ----------

function marcarConexion(texto, clase) {
  const chip = $('estadoConexion');
  chip.textContent = texto;
  chip.className = 'conexion ' + clase;
}

// Avisa (una sola vez) cuando un pedido creado desde esta página llega a su estado final.
function anunciarResultados() {
  for (const p of pedidos) {
    const antes = estadosVistos.get(p.pedidoId);
    estadosVistos.set(p.pedidoId, p.estado);
    if (propios.has(p.pedidoId) && antes && antes !== p.estado && p.estado !== 'En proceso') {
      mostrarAviso('Pedido ' + p.pedidoId + ': ' + p.estado);
    }
  }
}

async function refrescar() {
  const [resProductos, resPedidos, resServicios] = await Promise.allSettled([
    api('/productos'),
    api('/pedidos'),
    api('/servicios'),
  ]);

  if (resServicios.status === 'fulfilled') {
    const firma = JSON.stringify(resServicios.value);
    if (firma !== firmaServicios) {
      firmaServicios = firma;
      servicios = resServicios.value;
      pintarServicios();
    }
  }

  if (resPedidos.status === 'fulfilled') {
    const firma = JSON.stringify(resPedidos.value);
    if (firma !== firmaPedidos) {
      firmaPedidos = firma;
      pedidos = resPedidos.value;
      anunciarResultados();
      pintarFiltros();
      pintarPedidos();
      pintarCifras();
    }
  }
  if (resProductos.status === 'fulfilled' && !editando()) {
    const firma = JSON.stringify(resProductos.value);
    if (firma !== firmaProductos) {
      firmaProductos = firma;
      productos = resProductos.value;
      pintarProductos();
    }
  }

  if (resPedidos.status === 'rejected') marcarConexion('Sin conexión con el servidor', 'mal');
  else if (resProductos.status === 'rejected') marcarConexion('Inventario no responde', 'mal');
  else marcarConexion('Conectado', 'ok');
}

// ---------- Formularios ----------

$('formPedido').addEventListener('submit', async (evento) => {
  evento.preventDefault();
  const boton = $('btnPedido');
  errorForm('errPedido', 'formPedido', '');
  boton.disabled = true;
  boton.textContent = 'Creando… (puede tardar si los servicios están despertando)';
  $('formPedido').setAttribute('aria-busy', 'true');
  try {
    const resultado = await enviar('/pedidos', {
      productoId: Number($('selProducto').value),
      cantidad: Number($('inpCantidad').value),
      modo: $('selModo').value,
    });
    abiertos.add(resultado.pedidoId); // se muestra su recorrido abierto
    propios.add(resultado.pedidoId);
    mostrarAviso('Pedido ' + resultado.pedidoId + ' creado. Mira su recorrido en la sección Pedidos.');
    await refrescar();
  } catch (e) {
    errorForm('errPedido', 'formPedido', e.message);
  } finally {
    boton.disabled = false;
    boton.textContent = 'Crear pedido';
    $('formPedido').removeAttribute('aria-busy');
    boton.focus();
  }
});

$('formProducto').addEventListener('submit', async (evento) => {
  evento.preventDefault();
  const boton = $('btnProducto');
  errorForm('errProducto', 'formProducto', '');
  boton.disabled = true;
  try {
    const creado = await enviar('/productos', {
      nombre: $('inpNombre').value,
      stock: Number($('inpStock').value),
    });
    $('formProducto').reset();
    $('inpStock').value = '10';
    mostrarAviso('Producto creado: ' + creado.nombre);
    await refrescar();
  } catch (e) {
    errorForm('errProducto', 'formProducto', e.message);
  } finally {
    boton.disabled = false;
    boton.focus();
  }
});

$('btnCerrarError').addEventListener('click', () => { $('avisoError').hidden = true; });
$('btnAuto').addEventListener('click', () => {
  manual = !manual;
  $('btnAuto').setAttribute('aria-pressed', String(manual));
  $('btnAuto').textContent = manual ? 'Reanudar actualización' : 'Pausar actualización';
  mostrarAviso(manual ? 'Actualización automática en pausa.' : 'Actualización automática activa.');
  if (!manual) refrescar();
});

// Un error de JavaScript no previsto no debe dejar la página muda.
window.addEventListener('error', () => mostrarAviso('Ocurrió un error inesperado en la página. Recárgala si algo no responde.', 'mal'));
window.addEventListener('unhandledrejection', () => mostrarAviso('Ocurrió un error inesperado en la página. Recárgala si algo no responde.', 'mal'));

$('btnDespertar').addEventListener('click', despertar);
$('btnReanudar').addEventListener('click', reanudar);

// Cualquier uso de la página cuenta como actividad.
for (const nombre of ['pointerdown', 'keydown', 'scroll', 'touchstart']) {
  document.addEventListener(nombre, () => { ultimaActividad = Date.now(); });
}

$('selModo').addEventListener('change', () => {
  $('ayudaModo').textContent = AYUDA_MODO[$('selModo').value];
});

// Resalta en la barra la sección que se está viendo.
const enlaces = Array.from(document.querySelectorAll('.pill'));
enlaces[0].setAttribute('aria-current', 'location');
const secciones = enlaces.map((a) => document.querySelector(a.getAttribute('href')));
if ('IntersectionObserver' in window) {
  const observador = new IntersectionObserver(
    (entradas) => {
      for (const entrada of entradas) {
        if (entrada.isIntersecting) {
          for (const a of enlaces) {
            const activo = a.getAttribute('href') === '#' + entrada.target.id;
            a.classList.toggle('activo', activo);
            if (activo) a.setAttribute('aria-current', 'location');
            else a.removeAttribute('aria-current');
          }
        }
      }
    },
    { rootMargin: '-30% 0px -60% 0px' }
  );
  for (const seccion of secciones) if (seccion) observador.observe(seccion);
}

// ---------- Arranque ----------

$('ayudaModo').textContent = AYUDA_MODO[$('selModo').value];
pintarFiltros();
pintarPedidos();
refrescar().then(() => {
  if (servicios.length > 0) despertar(); // en la nube: despierta a los demás servicios al abrir
});

// Una consulta termina antes de programar la siguiente (no se encimen). Cada 2 s mientras haya
// pedidos en proceso; en reposo, cada 8 s para gastar menos mensajes del plan gratis.
async function ciclo() {
  try {
    if (!document.hidden && !pausado && !manual) {
      if (Date.now() - ultimaActividad > MINUTOS_SIN_ACTIVIDAD * 60 * 1000) {
        pausar();
      } else {
        if (servicios.length > 0 && Date.now() - ultimoDespertar > MINUTOS_ENTRE_DESPERTARES * 60 * 1000) {
          despertar(); // mantiene despiertos a los servicios mientras alguien usa la página
        }
        await refrescar();
      }
    }
  } catch (e) {
    marcarConexion('Sin conexión con el servidor', 'mal');
  }
  setTimeout(ciclo, pedidos.some((p) => p.estado === 'En proceso') ? 2000 : 8000);
}
setTimeout(ciclo, 2000);
