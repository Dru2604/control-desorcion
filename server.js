const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 3001;

// Middlewares
app.use(cors());
app.use(express.json());

// Conexión a Supabase deshabilitando la comprobación estricta de certificados SSL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// Middleware de verificación para rutas exclusivas de Gerencia
function verificarGerencia(req, res, next) {
  const rol = req.headers['x-rol-usuario'] || req.body.rol_usuario;
  if (rol !== 'GERENCIA') {
    return res.status(403).json({ 
      success: false, 
      error: 'Acceso denegado. Este módulo es exclusivo para Gerencia.' 
    });
  }
  next();
}

// Endpoint: Inicio de sesión
app.post('/api/login', async (req, res) => {
  const { usuario, password } = req.body;
  try {
    const result = await pool.query(
      'SELECT usuario, nombre, rol FROM usuarios WHERE usuario = $1 AND password = $2',
      [usuario, password]
    );

    if (result.rows.length > 0) {
      res.json({ success: true, usuario: result.rows[0] });
    } else {
      res.status(401).json({ success: false, error: 'Usuario o contraseña incorrectos.' });
    }
  } catch (err) {
    console.error('Error en /api/login:', err);
    res.status(500).json({ success: false, error: 'Error en el servidor o base de datos.' });
  }
});

// Endpoint: Obtener historial de cargas con sus lotes
app.get('/api/cargas', async (req, res) => {
  try {
    const cargasResult = await pool.query('SELECT * FROM cargas ORDER BY fecha DESC');
    const cargas = cargasResult.rows;

    for (let carga of cargas) {
      const lotesResult = await pool.query('SELECT * FROM lotes WHERE carga_id = $1', [carga.id]);
      carga.lotes = lotesResult.rows;
    }

    res.json({ success: true, data: cargas });
  } catch (err) {
    console.error('Error al obtener cargas:', err);
    res.status(500).json({ success: false, error: 'Error al consultar las cargas.' });
  }
});

// Endpoint: Registrar nueva carga con sus lotes (Versión corregida y blindada)
app.post('/api/cargas', async (req, res) => {
  const { codigo_carga, proveedor, usuario_registro, lotes } = req.body;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Inserción de la carga con estado por defecto 'Por Liquidar'
    const resCarga = await client.query(
      'INSERT INTO cargas (codigo_carga, proveedor, usuario_registro, estado) VALUES ($1, $2, $3, $4) RETURNING id',
      [codigo_carga, proveedor, usuario_registro, 'Por Liquidar']
    );
    const cargaId = resCarga.rows[0].id;

    for (let lote of lotes) {
      // Cálculos de pesos y número de muestras
      const arrayMuestras = lote.pesos_muestras || [];
      const cantidadMuestras = arrayMuestras.length;
      const pesoMuestrasTotal = arrayMuestras.reduce((a, b) => a + Number(b), 0);
      
      const pesoBruto = Number(lote.peso_bruto) || 0;
      const tara = Number(lote.tara) || 0;
      const porcentajeHumedad = Number(lote.porcentaje_humedad) || 0;

      const pesoNetoHumedo = pesoBruto - tara - pesoMuestrasTotal;
      const pesoSecoNeto = pesoNetoHumedo * (1 - porcentajeHumedad / 100);

      await client.query(
        `INSERT INTO lotes 
          (carga_id, codigo_lote, peso_bruto, tara, peso_muestras_total, cantidad_muestras, porcentaje_humedad, peso_seco_neto, pesos_muestras, ley_au_g_kg, ley_ag_g_kg, embalaje, punto_recepcion, ubicacion_fisica) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          cargaId,
          lote.codigo_lote,
          pesoBruto,
          tara,
          pesoMuestrasTotal.toFixed(2),
          cantidadMuestras,
          porcentajeHumedad,
          pesoSecoNeto.toFixed(2),
          JSON.stringify(arrayMuestras),
          Number(lote.ley_au_g_kg) || 0,
          Number(lote.ley_ag_g_kg) || 0,
          lote.embalaje || 'SACOS',
          lote.punto_recepcion || 'CHAPARRA',
          lote.ubicacion_fisica || 'Stock físico'
        ]
      );
    }

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error al guardar carga:', err);
    res.status(500).json({ success: false, error: 'Error interno al guardar la carga en la base de datos.' });
  } finally {
    client.release();
  }
});

// Endpoint: Actualizar estado de la carga
app.patch('/api/cargas/:id/estado', async (req, res) => {
  const { id } = req.params;
  const { estado, rol_usuario } = req.body;

  if (rol_usuario !== 'ADMIN' && rol_usuario !== 'SUPERVISOR' && rol_usuario !== 'GERENCIA') {
    return res.status(403).json({ success: false, error: 'No tienes permisos para cambiar el estado.' });
  }

  try {
    await pool.query('UPDATE cargas SET estado = $1 WHERE id = $2', [estado, id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Error al actualizar estado:', err);
    res.status(500).json({ success: false, error: 'Error al actualizar el estado.' });
  }
});

// Endpoint: Vaciar historial (Solo ADMIN)
app.delete('/api/cargas', async (req, res) => {
  const { rol_usuario } = req.body;

  if (rol_usuario !== 'ADMIN') {
    return res.status(403).json({ success: false, error: 'Solo los administradores pueden borrar el historial.' });
  }

  try {
    await pool.query('TRUNCATE TABLE cargas CASCADE');
    res.json({ success: true });
  } catch (err) {
    console.error('Error al borrar historial:', err);
    res.status(500).json({ success: false, error: 'Error al vaciar la base de datos.' });
  }
});

// ==========================================
// MÓDULO EXCLUSIVO DE GERENCIA / CONTROL MAESTRO
// ==========================================

// Endpoint: Obtener Precios e Indicadores Financieros
app.get('/api/gerencia/parametros', verificarGerencia, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM parametros_gerencia ORDER BY id DESC LIMIT 1');
    res.json({ success: true, data: rows[0] || { precio_inter_au_usd: 4600, precio_inter_ag_usd: 68, factor_oz_g: 31.1035 } });
  } catch (err) {
    console.error('Error al obtener parámetros:', err);
    res.status(500).json({ success: false, error: 'Error al consultar parámetros gerenciales.' });
  }
});

// Endpoint: Actualizar Precios e Indicadores Financieros
app.post('/api/gerencia/parametros', verificarGerencia, async (req, res) => {
  const { precio_inter_au_usd, precio_inter_ag_usd, factor_oz_g } = req.body;
  try {
    await pool.query(
      'INSERT INTO parametros_gerencia (precio_inter_au_usd, precio_inter_ag_usd, factor_oz_g) VALUES ($1, $2, $3)',
      [precio_inter_au_usd, precio_inter_ag_usd, factor_oz_g || 31.1035]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Error al actualizar parámetros:', err);
    res.status(500).json({ success: false, error: 'Error al guardar parámetros.' });
  }
});

// Endpoint: Actualizar Leyes de Laboratorio en un Lote Específico
app.patch('/api/lotes/:id/leyes', verificarGerencia, async (req, res) => {
  const { id } = req.params;
  const { ley_au_g_kg, ley_ag_g_kg, ubicacion_fisica } = req.body;

  try {
    await pool.query(
      'UPDATE lotes SET ley_au_g_kg = $1, ley_ag_g_kg = $2, ubicacion_fisica = $3 WHERE id = $4',
      [ley_au_g_kg || 0, ley_ag_g_kg || 0, ubicacion_fisica || 'Stock físico', id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Error al actualizar leyes:', err);
    res.status(500).json({ success: false, error: 'Error al actualizar las leyes del lote.' });
  }
});

// Endpoint: Reporte Control Maestro de Carbón y Valorización (Solo GERENCIA)
app.get('/api/gerencia/control-maestro', verificarGerencia, async (req, res) => {
  try {
    const paramsRes = await pool.query('SELECT * FROM parametros_gerencia ORDER BY id DESC LIMIT 1');
    const params = paramsRes.rows[0] || { precio_inter_au_usd: 4600, precio_inter_ag_usd: 68, factor_oz_g: 31.1035 };
    
    const factor = Number(params.factor_oz_g);
    const precioAu = Number(params.precio_inter_au_usd);
    const precioAg = Number(params.precio_inter_ag_usd);

    const query = `
      SELECT 
        c.proveedor,
        l.codigo_lote,
        c.estado AS estatus,
        l.ubicacion_fisica,
        l.peso_bruto,
        l.porcentaje_humedad,
        l.peso_seco_neto,
        l.ley_au_g_kg,
        l.ley_ag_g_kg,
        (l.peso_seco_neto * l.ley_au_g_kg) AS finos_au_g,
        (l.peso_seco_neto * l.ley_ag_g_kg) AS finos_ag_g,
        ((l.peso_seco_neto * l.ley_au_g_kg) / $1) AS au_oz,
        ((l.peso_seco_neto * l.ley_ag_g_kg) / $1) AS ag_oz,
        (((l.peso_seco_neto * l.ley_au_g_kg) / $1) * $2) AS valor_au_usd,
        (((l.peso_seco_neto * l.ley_ag_g_kg) / $1) * $3) AS valor_ag_usd,
        ((((l.peso_seco_neto * l.ley_au_g_kg) / $1) * $2) + (((l.peso_seco_neto * l.ley_ag_g_kg) / $1) * $3)) AS valor_total_usd
      FROM cargas c
      JOIN lotes l ON c.id = l.carga_id
      ORDER BY c.proveedor ASC, l.codigo_lote ASC;
    `;

    const { rows } = await pool.query(query, [factor, precioAu, precioAg]);

    res.json({
      success: true,
      parametros: params,
      data: rows
    });
  } catch (err) {
    console.error('Error en control maestro:', err);
    res.status(500).json({ success: false, error: 'Error al generar reporte de control maestro.' });
  }
});

app.listen(port, () => {
  console.log(`Servidor ejecutándose en el puerto ${port}`);
});
