'use strict';

/* ============================================================
   SagaPedidos - lógica de la página.
   Flujo: esta página -> API del frontend (/api) -> RabbitMQ -> servicios.
   La página consulta /api cada 2 segundos para mostrar los cambios.
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
  NotificacionFallida: 'No se pudo notificar al cliente',
};

const CLASE_ESTADO = {
  Confirmado: 'ok',
  Cancelado: 'mal',
  Rechazado: 'aviso',
  'En proceso': 'info',
  'Pagado sin notificar': 'raro',
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
  const respuesta = await fetch('/api' + ruta, opciones);
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

function mostrarAviso(texto, tipo) {
  const aviso = $('aviso');
  aviso.textContent = texto;
  aviso.className = 'aviso' + (tipo === 'mal' ? ' mal' : '');
  aviso.hidden = false;
  clearTimeout(temporizadorAviso);
  temporizadorAviso = setTimeout(() => { aviso.hidden = true; }, 4500);
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
  const boton = el('button', { clase: 'btn btn-claro btn-chico', texto: 'Reponer', atributos: { type: 'button' } });
  boton.addEventListener('click', async () => {
    boton.disabled = true;
    try {
      await enviar('/productos/' + p.id + '/reponer', { cantidad: Number(entrada.value) });
      mostrarAviso('Stock repuesto: ' + p.nombre);
      await refrescar();
    } catch (e) {
      mostrarAviso(e.message, 'mal');
    } finally {
      boton.disabled = false;
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
  grilla.replaceChildren();
  if (productos.length === 0) {
    grilla.appendChild(el('p', { clase: 'vacio', texto: 'Todavía no hay productos. Crea el primero.' }));
  }
  for (const p of productos) grilla.appendChild(tarjetaProducto(p));

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
  contenedor.replaceChildren();
  for (const nombre of FILTROS) {
    const cantidad = nombre === 'Todos' ? pedidos.length : pedidos.filter((p) => p.estado === nombre).length;
    const boton = el('button', {
      clase: 'filtro' + (nombre === filtroActual ? ' on' : ''),
      texto: nombre + ' (' + cantidad + ')',
      atributos: { type: 'button', 'aria-pressed': String(nombre === filtroActual) },
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
    atributos: { type: 'button', 'aria-expanded': String(abierto) },
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
  lista.replaceChildren();
  const visibles = pedidos.filter((p) => filtroActual === 'Todos' || p.estado === filtroActual);
  if (visibles.length === 0) {
    lista.appendChild(
      el('p', { clase: 'vacio', texto: pedidos.length === 0 ? 'Todavía no hay pedidos. Crea el primero arriba.' : 'No hay pedidos con ese estado.' })
    );
    return;
  }
  for (const pedido of visibles) lista.appendChild(tarjetaPedido(pedido));
}

function pintarCifras() {
  $('cifraTotal').textContent = String(pedidos.length);
  $('cifraOk').textContent = String(pedidos.filter((p) => p.estado === 'Confirmado').length);
  $('cifraMal').textContent = String(pedidos.filter((p) => p.estado === 'Cancelado').length);
}

// ---------- Actualización periódica ----------

function marcarConexion(texto, clase) {
  const chip = $('estadoConexion');
  chip.textContent = texto;
  chip.className = 'conexion ' + clase;
}

async function refrescar() {
  const [resProductos, resPedidos] = await Promise.allSettled([api('/productos'), api('/pedidos')]);

  if (resPedidos.status === 'fulfilled') {
    const firma = JSON.stringify(resPedidos.value);
    if (firma !== firmaPedidos) {
      firmaPedidos = firma;
      pedidos = resPedidos.value;
      pintarFiltros();
      pintarPedidos();
      pintarCifras();
    }
  }
  if (resProductos.status === 'fulfilled') {
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
  boton.disabled = true;
  try {
    const resultado = await enviar('/pedidos', {
      productoId: Number($('selProducto').value),
      cantidad: Number($('inpCantidad').value),
      modo: $('selModo').value,
    });
    abiertos.add(resultado.pedidoId); // se muestra su recorrido abierto
    mostrarAviso('Pedido ' + resultado.pedidoId + ' creado. Mira su recorrido en la sección Pedidos.');
    await refrescar();
  } catch (e) {
    mostrarAviso(e.message, 'mal');
  } finally {
    boton.disabled = false;
  }
});

$('formProducto').addEventListener('submit', async (evento) => {
  evento.preventDefault();
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
    mostrarAviso(e.message, 'mal');
  }
});

$('selModo').addEventListener('change', () => {
  $('ayudaModo').textContent = AYUDA_MODO[$('selModo').value];
});

// Resalta en la barra la sección que se está viendo.
const enlaces = Array.from(document.querySelectorAll('.pill'));
const secciones = enlaces.map((a) => document.querySelector(a.getAttribute('href')));
if ('IntersectionObserver' in window) {
  const observador = new IntersectionObserver(
    (entradas) => {
      for (const entrada of entradas) {
        if (entrada.isIntersecting) {
          for (const a of enlaces) {
            a.classList.toggle('activo', a.getAttribute('href') === '#' + entrada.target.id);
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
refrescar();
setInterval(() => {
  if (!document.hidden) refrescar();
}, 2000);
