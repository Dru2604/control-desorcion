const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'llave_secreta_super_segura_planta_2026';

// Middlewares de Seguridad y Parsing
app.use(helmet());
app.use(cors({ origin: process.env.CLIENT_ORIGIN || '*' }));
app.use(express.json());

// Configuración de la base de datos PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: true } : { rejectUnauthorized: false }
});

pool.on('error', (err) => {
  console.error('Error inesperado en cliente inactivo de PostgreSQL:', err);
});

// MIDDLEWARES DE AUTENTICACIÓN Y AUTORIZACIÓN

function autenticarToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ success: false, error: 'Acceso denegado. Token no proporcionado.' });
  }

  jwt.verify(token, JWT_SECRET, (err, usuario) => {
    if (err) return res.status(403).json({ success: false, error: 'Token inválido o expirado.' });
    req.usuario = usuario;
    next();
  });
}

function requerirRol(...rolesPermitidos) {
  return (req, res, next) => {
    if (!rolesPermitidos.includes(req.usuario.rol)) {
      return res.status(403).json({ success: false, error: 'No posee los permisos requeridos para esta acción.' });
    }
    next();
  };
}

// ENDPOINTS API

// 1. AUTENTICACIÓN
app.post('/api/login', async (req, res) => {
  const { usuario, password } = req.body;
  if (!usuario || !password) {
    return res.status(400).json({ success: false, error: 'Usuario y contraseña requeridos.' });
  }

  try {
    const result = await pool.query('SELECT id, usuario, nombre, rol, password FROM usuarios WHERE usuario = $1', [usuario]);
    if (result.rows.length === 0) {
      return res.status(401).json({ success: false, error: 'Credenciales inválidas.' });
    }

    const user = result.rows[0];
    const passwordValido = await bcrypt.compare(password, user.password);

    if (!passwordValido) {
      return res.status(401).json({ success: false, error: 'Credenciales inválidas.' });
    }

    const token = jwt.sign(
      { id: user.id, usuario: user.usuario, nombre: user.nombre, rol: user.rol },
      JWT_SECRET,
      { expiresIn: '8h' }
    );

    res.json({
      success: true,
      token,
      usuario: { id: user.id, usuario: user.usuario, nombre: user.nombre, rol: user.rol }
    });
  } catch (err) {
    console.error('Error en Login:', err);
    res.status(500).json({ success: false, error: 'Error interno del servidor.' });
  }
});

// 2. OBTENER CARGAS E HISTORIAL (Consulta optimizada)
app.get('/api/cargas', autenticarToken, async (req, res) => {
  try {
    const query = `
      SELECT 
        c.*,
        COALESCE(
          json_agg(
            json_build_object(
              'id', l.id,
              'codigo_lote', l.codigo_lote,
              'cantidad_sacos', l.cantidad_sacos,
              'peso_bruto', l.peso_bruto,
              'tara', l.tara,
              'peso_seco_neto', l.peso_seco_neto,
              'ley_au_g_kg', l.ley_au_g_kg,
              'ley_ag_g_kg', l.ley_ag_g_kg,
              'ubicacion_fisica', l.ubicacion_fisica,
              'descripcion_acta', CONCAT('CARBON ACTIVADO – ', COALESCE(l.cantidad_sacos::text || ' SACOS', 'NUMERO DE SACOS'))
            ) ORDER BY l.id ASC
          ) FILTER (WHERE l.id IS NOT NULL), '[]'
        ) AS lotes
      FROM cargas c
      LEFT JOIN lotes l ON c.id = l.carga_id
      GROUP BY c.id
      ORDER BY c.fecha DESC;
    `;

    const { rows } = await pool.query(query);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('Error al consultar cargas:', err);
    res.status(500).json({ success: false, error: 'Error al consultar el historial de cargas.' });
  }
});

// 3. REGISTRAR NUEVA CARGA Y LOTES
app.post('/api/cargas', autenticarToken, async (req, res) => {
  const { 
    codigo_carga, proveedor, ruc_proveedor, numero_chaparra, guia_remision, guia_transportista, 
    fecha_operacion, lotes 
  } = req.body;

  if (!lotes || !Array.isArray(lotes) || lotes.length === 0) {
    return res.status(400).json({ success: false, error: 'Debe incluir al menos un lote.' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const resCarga = fecha_operacion 
      ? await client.query(
          `INSERT INTO cargas (codigo_carga, proveedor, ruc_proveedor, numero_chaparra, guia_remision, guia_transportista, usuario_registro, estado, fecha) 
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`, 
          [codigo_carga, proveedor, ruc_proveedor || '', numero_chaparra || '', guia_remision || '', guia_transportista || '', req.usuario.usuario, 'Por Liquidar', fecha_operacion]
        )
      : await client.query(
          `INSERT INTO cargas (codigo_carga, proveedor, ruc_proveedor, numero_chaparra, guia_remision, guia_transportista, usuario_registro, estado) 
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`, 
          [codigo_carga, proveedor, ruc_proveedor || '', numero_chaparra || '', guia_remision || '', guia_transportista || '', req.usuario.usuario, 'Por Liquidar']
        );

    const cargaId = resCarga.rows[0].id;

    for (let lote of lotes) {
      const arrayMuestrasGramos = lote.pesos_muestras || [];
      const totalMuestrasGramos = arrayMuestrasGramos.reduce((a, b) => a + Number(b), 0);
      const pesoMuestrasKg = totalMuestrasGramos / 1000;
      
      const pesoBruto = Number(lote.peso_bruto) || 0;
      const tara = Number(lote.tara) || 0;
      const porcentajeHumedad = Number(lote.porcentaje_humedad) || 0;
      const cantidadSacos = Number(lote.cantidad_sacos) || 0;

      const pesoNetoHumedo = pesoBruto - tara - pesoMuestrasKg;
      const descuentoHumedadKg = pesoNetoHumedo * (porcentajeHumedad / 100);
      const pesoSecoNeto = pesoNetoHumedo - descuentoHumedadKg;

      await client.query(
        `INSERT INTO lotes 
          (carga_id, codigo_lote, cantidad_sacos, peso_bruto, tara, peso_muestras_total, cantidad_muestras, peso_humedo_neto, porcentaje_humedad, descuento_humedad_kg, peso_seco_neto, pesos_muestras, ley_au_g_kg, ley_ag_g_kg, embalaje, punto_recepcion, ubicacion_fisica) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
        [
          cargaId, lote.codigo_lote, cantidadSacos, pesoBruto, tara, pesoMuestrasKg.toFixed(3), 
          arrayMuestrasGramos.length, pesoNetoHumedo.toFixed(2), porcentajeHumedad, 
          descuentoHumedadKg.toFixed(2), Math.max(0, pesoSecoNeto).toFixed(2), JSON.stringify(arrayMuestrasGramos), 
          Number(lote.ley_au_g_kg) || 0, Number(lote.ley_ag_g_kg) || 0, 'SACOS', 'CHAPARRA', 'Stock físico'
        ]
      );
    }

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error al guardar carga:', err);
    res.status(500).json({ success: false, error: 'Error interno al procesar la carga.' });
  } finally {
    client.release();
  }
});

// 4. DECLARACIONES JURADAS
app.get('/api/declaraciones', autenticarToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM declaraciones_juradas ORDER BY created_at DESC');
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Error al obtener declaraciones juradas.' });
  }
});

app.post('/api/declaraciones', autenticarToken, async (req, res) => {
  const {
    nombre_conductor, dni_conductor, licencia_conductor, calidad_empresa, ruc_empresa,
    proveedor_emisor, fecha_traslado, guia_remision, ruta_usada, punto_partida,
    punto_llegada, placa_vehiculo, propietario_vehiculo, fecha_documento, nombre_firma
  } = req.body;

  try {
    const result = await pool.query(
      `INSERT INTO declaraciones_juradas 
        (nombre_conductor, dni_conductor, licencia_conductor, calidad_empresa, ruc_empresa, proveedor_emisor, fecha_traslado, guia_remision, ruta_usada, punto_partida, punto_llegada, placa_vehiculo, propietario_vehiculo, fecha_documento, nombre_firma, usuario_registro)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING *`,
      [
        nombre_conductor, dni_conductor, licencia_conductor, calidad_empresa, ruc_empresa,
        proveedor_emisor, fecha_traslado, guia_remision, ruta_usada, punto_partida,
        punto_llegada, placa_vehiculo, propietario_vehiculo, fecha_documento, nombre_firma, req.usuario.usuario
      ]
    );

    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error('Error al guardar DJ:', err);
    res.status(500).json({ success: false, error: 'Error al guardar la Declaración Jurada.' });
  }
});

// 5. CERTIFICADOS DE PROCEDENCIA
app.get('/api/certificados', autenticarToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM certificados_procedencia ORDER BY created_at DESC');
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Error al consultar certificados.' });
  }
});

app.post('/api/certificados', autenticarToken, async (req, res) => {
  const {
    nombre_declarante, dni_declarante, ruc_declarante, domicilio_fiscal, condicion_minero,
    nombre_concesion, codigo_concesion, distrito, provincia, departamento,
    nombres_firmante, apellidos_firmante, dni_firmante, fecha_emision
  } = req.body;

  try {
    const result = await pool.query(
      `INSERT INTO certificados_procedencia 
        (nombre_declarante, dni_declarante, ruc_declarante, domicilio_fiscal, condicion_minero,
         nombre_concesion, codigo_concesion, distrito, provincia, departamento,
         nombres_firmante, apellidos_firmante, dni_firmante, fecha_emision, usuario_registro)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING *`,
      [
        nombre_declarante, dni_declarante, ruc_declarante, domicilio_fiscal, condicion_minero,
        nombre_concesion, codigo_concesion, distrito, provincia, departamento,
        nombres_firmante, apellidos_firmante, dni_firmante, fecha_emision, req.usuario.usuario
      ]
    );

    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error('Error al guardar Certificado:', err);
    res.status(500).json({ success: false, error: 'Error al guardar el Certificado de Procedencia.' });
  }
});

// 6. CAMBIAR ESTADO DE CARGA
app.patch('/api/cargas/:id/estado', autenticarToken, requerirRol('ADMIN', 'SUPERVISOR', 'GERENCIA'), async (req, res) => {
  const { id } = req.params;
  const { estado } = req.body;

  try {
    await pool.query('UPDATE cargas SET estado = $1 WHERE id = $2', [estado, id]);
    res.json({ success: true });
  } catch (err) { 
    res.status(500).json({ success: false, error: 'Error al actualizar el estado.' }); 
  }
});

// 7. VACIAR BASE DE DATOS
app.delete('/api/cargas', autenticarToken, requerirRol('ADMIN', 'GERENCIA'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('TRUNCATE TABLE inventario_carbon_desorbido, lotes, cargas, declaraciones_juradas, certificados_procedencia RESTART IDENTITY CASCADE');
    await client.query('COMMIT');

    res.json({ success: true, message: 'Historial completado y limpiado exitosamente.' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error al vaciar BD:', err);
    res.status(500).json({ success: false, error: 'Error al reiniciar la base de datos.' });
  } finally {
    client.release();
  }
});

// 8. REPORTES MENSUALES
app.get('/api/reportes/mensual', autenticarToken, requerirRol('ADMIN', 'GERENCIA'), async (req, res) => {
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
  } catch (err) { 
    res.status(500).json({ success: false, error: 'Error al generar reporte.' }); 
  }
});

// 9. CONSULTAR MOVIMIENTOS Y PENDIENTES
app.get('/api/carbon-desorbido', autenticarToken, async (req, res) => {
  try {
    const movimientosResult = await pool.query('SELECT * FROM inventario_carbon_desorbido ORDER BY fecha DESC');
    const pendientesResult = await pool.query(`
      SELECT l.id AS lote_id, c.proveedor, l.codigo_lote, COALESCE(l.peso_bruto, 0) AS peso_bruto, COALESCE(l.peso_seco_neto, 0) AS peso_seco_neto, l.ubicacion_fisica
      FROM cargas c JOIN lotes l ON c.id = l.carga_id 
      WHERE l.devuelto_al_cliente = FALSE OR l.devuelto_al_cliente IS NULL
      ORDER BY c.proveedor ASC, l.codigo_lote ASC
    `);
    res.json({ success: true, movimientos: movimientosResult.rows, pendientesDevolucion: pendientesResult.rows });
  } catch (err) { 
    res.status(500).json({ success: false, error: 'Error al consultar inventario.' }); 
  }
});

// 10. REGISTRAR MOVIMIENTO DE CARBÓN DESORBIDO
app.post('/api/carbon-desorbido', autenticarToken, async (req, res) => {
  const { tipo_movimiento, proveedor, codigo_lote, peso_seco_kg, observaciones, lote_id } = req.body;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO inventario_carbon_desorbido (tipo_movimiento, proveedor, codigo_lote, peso_seco_kg, observaciones, usuario_registro) VALUES ($1, $2, $3, $4, $5, $6)`,
      [tipo_movimiento, proveedor, codigo_lote, Number(peso_seco_kg) || 0, observaciones || '', req.usuario.usuario]
    );

    if (tipo_movimiento === 'DEVOLUCION_CLIENTE' && lote_id) {
      await client.query('UPDATE lotes SET devuelto_al_cliente = TRUE, ubicacion_fisica = $1 WHERE id = $2', ['Devuelto a Cliente', lote_id]);
    }

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, error: 'Error interno al registrar el movimiento.' });
  } finally { 
    client.release(); 
  }
});

// 11. CONTROL MAESTRO GERENCIA
app.get('/api/gerencia/control-maestro', autenticarToken, requerirRol('GERENCIA'), async (req, res) => {
  try {
    const paramsRes = await pool.query('SELECT * FROM parametros_gerencia ORDER BY id DESC LIMIT 1');
    const params = paramsRes.rows[0] || { precio_inter_au_usd: 4600, precio_inter_ag_usd: 68, factor_oz_g: 31.1035 };
    
    const factor = Number(params.factor_oz_g);
    const precioAu = Number(params.precio_inter_au_usd);
    const precioAg = Number(params.precio_inter_ag_usd);

    const query = `
      SELECT 
        c.proveedor, l.codigo_lote, c.estado AS estatus, l.ubicacion_fisica, l.peso_bruto, l.porcentaje_humedad, l.peso_seco_neto, l.ley_au_g_kg, l.ley_ag_g_kg,
        (l.peso_seco_neto * l.ley_au_g_kg) AS finos_au_g, 
        (l.peso_seco_neto * l.ley_ag_g_kg) AS finos_ag_g,
        ((l.peso_seco_neto * l.ley_au_g_kg) / $1) AS au_oz, 
        ((l.peso_seco_neto * l.ley_ag_g_kg) / $1) AS ag_oz,
        (((l.peso_seco_neto * l.ley_au_g_kg) / $1) * $2) AS valor_au_usd, 
        (((l.peso_seco_neto * l.ley_ag_g_kg) / $1) * $3) AS valor_ag_usd,
        ((((l.peso_seco_neto * l.ley_au_g_kg) / $1) * $2) + (((l.peso_seco_neto * l.ley_ag_g_kg) / $1) * $3)) AS valor_total_usd
      FROM cargas c 
      JOIN lotes l ON c.id = l.carga_id 
      ORDER BY c.fecha DESC, c.proveedor ASC, l.codigo_lote ASC;
    `;
    const { rows } = await pool.query(query, [factor, precioAu, precioAg]);
    res.json({ success: true, parametros: params, data: rows });
  } catch (err) { 
    console.error('Error en control maestro:', err);
    res.status(500).json({ success: false, error: 'Error al generar reporte maestro.' }); 
  }
});

app.listen(port, () => console.log(`Servidor de produccion escuchando en puerto ${port}`));
