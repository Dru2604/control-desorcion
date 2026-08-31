const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

function verificarGerencia(req, res, next) {
  const rol = req.headers['x-rol-usuario'] || req.body.rol_usuario;
  if (rol !== 'GERENCIA') {
    return res.status(403).json({ success: false, error: 'Acceso denegado. Exclusivo para Gerencia.' });
  }
  next();
}

app.post('/api/login', async (req, res) => {
  const { usuario, password } = req.body;
  try {
    const result = await pool.query('SELECT usuario, nombre, rol FROM usuarios WHERE usuario = $1 AND password = $2', [usuario, password]);
    if (result.rows.length > 0) res.json({ success: true, usuario: result.rows[0] });
    else res.status(401).json({ success: false, error: 'Usuario o contraseña incorrectos.' });
  } catch (err) { res.status(500).json({ success: false, error: 'Error en el servidor.' }); }
});

app.get('/api/cargas', async (req, res) => {
  try {
    const cargasResult = await pool.query('SELECT * FROM cargas ORDER BY fecha DESC');
    const cargas = cargasResult.rows;
    for (let carga of cargas) {
      const lotesResult = await pool.query('SELECT * FROM lotes WHERE carga_id = $1 ORDER BY id ASC', [carga.id]);
      carga.lotes = lotesResult.rows;
    }
    res.json({ success: true, data: cargas });
  } catch (err) { res.status(500).json({ success: false, error: 'Error al consultar cargas.' }); }
});

app.post('/api/cargas', async (req, res) => {
  const { codigo_carga, proveedor, usuario_registro, fecha_operacion, lotes } = req.body;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    let resCarga = fecha_operacion 
      ? await client.query('INSERT INTO cargas (codigo_carga, proveedor, usuario_registro, estado, fecha) VALUES ($1, $2, $3, $4, $5) RETURNING id', [codigo_carga, proveedor, usuario_registro, 'Por Liquidar', fecha_operacion])
      : await client.query('INSERT INTO cargas (codigo_carga, proveedor, usuario_registro, estado) VALUES ($1, $2, $3, $4) RETURNING id', [codigo_carga, proveedor, usuario_registro, 'Por Liquidar']);

    const cargaId = resCarga.rows[0].id;

    for (let lote of lotes) {
      const arrayMuestrasGramos = lote.pesos_muestras || [];
      const totalMuestrasGramos = arrayMuestrasGramos.reduce((a, b) => a + Number(b), 0);
      const pesoMuestrasKg = totalMuestrasGramos / 1000;
      
      const pesoBruto = Number(lote.peso_bruto) || 0;
      const tara = Number(lote.tara) || 0;
      const porcentajeHumedad = Number(lote.porcentaje_humedad) || 0;

      const pesoNetoHumedo = pesoBruto - tara - pesoMuestrasKg;
      const descuentoHumedadKg = pesoNetoHumedo * (porcentajeHumedad / 100);
      const pesoSecoNeto = pesoNetoHumedo - descuentoHumedadKg;

      await client.query(
        `INSERT INTO lotes 
          (carga_id, codigo_lote, peso_bruto, tara, peso_muestras_total, cantidad_muestras, peso_humedo_neto, porcentaje_humedad, descuento_humedad_kg, peso_seco_neto, pesos_muestras, ley_au_g_kg, ley_ag_g_kg, embalaje, punto_recepcion, ubicacion_fisica) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [cargaId, lote.codigo_lote, pesoBruto, tara, pesoMuestrasKg.toFixed(3), arrayMuestrasGramos.length, pesoNetoHumedo.toFixed(2), porcentajeHumedad, descuentoHumedadKg.toFixed(2), pesoSecoNeto.toFixed(2), JSON.stringify(arrayMuestrasGramos), Number(lote.ley_au_g_kg) || 0, Number(lote.ley_ag_g_kg) || 0, 'SACOS', 'CHAPARRA', 'Stock físico']
      );
    }

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, error: 'Error al guardar.' });
  } finally { client.release(); }
});

app.patch('/api/cargas/:id/estado', async (req, res) => {
  const { id } = req.params;
  const { estado, rol_usuario } = req.body;
  if (rol_usuario !== 'ADMIN' && rol_usuario !== 'SUPERVISOR' && rol_usuario !== 'GERENCIA') return res.status(403).json({ success: false, error: 'Sin permisos.' });
  try {
    await pool.query('UPDATE cargas SET estado = $1 WHERE id = $2', [estado, id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: 'Error al actualizar.' }); }
});

/* ENDPOINT VACIAR EN CASCADA COMPATIBLE CON SUPABASE */
app.delete('/api/cargas', async (req, res) => {
  const { rol_usuario } = req.body;
  if (rol_usuario !== 'ADMIN' && rol_usuario !== 'GERENCIA') {
    return res.status(403).json({ success: false, error: 'Acceso denegado. Solo administradores o gerencia pueden vaciar el historial.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('TRUNCATE TABLE inventario_carbon_desorbido RESTART IDENTITY CASCADE');
    await client.query('TRUNCATE TABLE lotes RESTART IDENTITY CASCADE');
    await client.query('TRUNCATE TABLE cargas RESTART IDENTITY CASCADE');
    await client.query('COMMIT');

    res.json({ success: true, message: 'Historial vaciado completamente.' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, error: 'Error al vaciar la base de datos.' });
  } finally {
    client.release();
  }
});

app.get('/api/reportes/mensual', async (req, res) => {
  const rol = req.headers['x-rol-usuario'];
  if (rol !== 'ADMIN' && rol !== 'GERENCIA') return res.status(403).json({ success: false, error: 'Acceso denegado.' });
  try {
    const query = `
      SELECT 
        TO_CHAR(c.fecha, 'YYYY-MM') AS periodo,
        TO_CHAR(c.fecha, 'TMMonth YYYY') AS mes_nombre,
        COUNT(DISTINCT c.id) AS total_cargas,
        COUNT(l.id) AS total_lotes,
        COALESCE(SUM(l.peso_bruto), 0) AS peso_bruto_total,
        COALESCE(SUM(l.peso_seco_neto), 0) AS peso_seco_total,
        COALESCE(SUM((l.peso_seco_neto * l.ley_au_g_kg) / 31.1035), 0) AS au_oz_total,
        COALESCE(SUM((((l.peso_seco_neto * l.ley_au_g_kg) / 31.1035) * 4600)), 0) AS valor_usd_total
      FROM cargas c LEFT JOIN lotes l ON c.id = l.carga_id
      GROUP BY TO_CHAR(c.fecha, 'YYYY-MM'), TO_CHAR(c.fecha, 'TMMonth YYYY')
      ORDER BY periodo DESC;
    `;
    const { rows } = await pool.query(query);
    res.json({ success: true, data: rows });
  } catch (err) { res.status(500).json({ success: false, error: 'Error al generar reporte.' }); }
});

app.get('/api/carbon-desorbido', async (req, res) => {
  try {
    const movimientosResult = await pool.query('SELECT * FROM inventario_carbon_desorbido ORDER BY fecha DESC');
    const pendientesResult = await pool.query(`
      SELECT l.id AS lote_id, c.proveedor, l.codigo_lote, COALESCE(l.peso_bruto, 0) AS peso_bruto, COALESCE(l.peso_seco_neto, 0) AS peso_seco_neto, l.ubicacion_fisica
      FROM cargas c JOIN lotes l ON c.id = l.carga_id 
      WHERE l.devuelto_al_cliente = FALSE OR l.devuelto_al_cliente IS NULL
      ORDER BY c.proveedor ASC, l.codigo_lote ASC
    `);
    res.json({ success: true, movimientos: movimientosResult.rows, pendientesDevolucion: pendientesResult.rows });
  } catch (err) { res.status(500).json({ success: false, error: 'Error al consultar inventario.' }); }
});

app.post('/api/carbon-desorbido', async (req, res) => {
  const { tipo_movimiento, proveedor, codigo_lote, peso_seco_kg, observaciones, usuario_registro, lote_id } = req.body;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO inventario_carbon_desorbido (tipo_movimiento, proveedor, codigo_lote, peso_seco_kg, observaciones, usuario_registro) VALUES ($1, $2, $3, $4, $5, $6)`,
      [tipo_movimiento, proveedor, codigo_lote, Number(peso_seco_kg) || 0, observaciones || '', usuario_registro]
    );

    if (tipo_movimiento === 'DEVOLUCION_CLIENTE' && lote_id) {
      await client.query('UPDATE lotes SET devuelto_al_cliente = TRUE, ubicacion_fisica = $1 WHERE id = $2', ['Devuelto a Cliente', lote_id]);
    }

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, error: 'Error interno al registrar el movimiento.' });
  } finally { client.release(); }
});

app.get('/api/gerencia/control-maestro', verificarGerencia, async (req, res) => {
  try {
    const paramsRes = await pool.query('SELECT * FROM parametros_gerencia ORDER BY id DESC LIMIT 1');
    const params = paramsRes.rows[0] || { precio_inter_au_usd: 4600, precio_inter_ag_usd: 68, factor_oz_g: 31.1035 };
    
    const factor = Number(params.factor_oz_g);
    const precioAu = Number(params.precio_inter_au_usd);
    const precioAg = Number(params.precio_inter_ag_usd);

    const query = `
      SELECT 
        c.proveedor, l.codigo_lote, c.estado AS estatus, l.ubicacion_fisica, l.peso_bruto, l.porcentaje_humedad, l.peso_seco_neto, l.ley_au_g_kg, l.ley_ag_g_kg,
        (l.peso_seco_neto * l.ley_au_g_kg) AS finos_au_g, (l.peso_seco_neto * l.ley_ag_g_kg) AS finos_ag_g,
        ((l.peso_seco_neto * l.ley_au_g_kg) / $1) AS au_oz, ((l.peso_seco_neto * l.ley_ag_g_kg) / $1) AS ag_oz,
        (((l.peso_seco_neto * l.ley_au_g_kg) / $1) * $2) AS valor_au_usd, (((l.peso_seco_neto * l.ley_ag_g_kg) / $1) * $3) AS valor_ag_usd,
        ((((l.peso_seco_neto * l.ley_au_g_kg) / $1) * $2) + (((l.peso_seco_neto * l.ley_ag_g_kg) / $1) * $3)) AS valor_total_usd
      FROM cargas c JOIN lotes l ON c.id = l.carga_id ORDER BY c.fecha DESC, c.proveedor ASC, l.codigo_lote ASC;
    `;
    const { rows } = await pool.query(query, [factor, precioAu, precioAg]);
    res.json({ success: true, parametros: params, data: rows });
  } catch (err) { res.status(500).json({ success: false, error: 'Error al generar reporte maestro.' }); }
});

app.listen(port, () => console.log(`Servidor ejecutándose en el puerto ${port}`));
