const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 3001;

// Middlewares
app.use(cors());
app.use(express.json());

// Conexión a Supabase con SSL habilitado
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

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

// Endpoint: Registrar nueva carga con sus lotes
app.post('/api/cargas', async (req, res) => {
  const { codigo_carga, proveedor, usuario_registro, lotes } = req.body;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const resCarga = await client.query(
      'INSERT INTO cargas (codigo_carga, proveedor, usuario_registro) VALUES ($1, $2, $3) RETURNING id',
      [codigo_carga, proveedor, usuario_registro]
    );
    const cargaId = resCarga.rows[0].id;

    for (let lote of lotes) {
      // Cálculos de peso
      const pesoMuestrasTotal = lote.pesos_muestras.reduce((a, b) => a + b, 0);
      const pesoNetoHumedo = lote.peso_bruto - lote.tara - pesoMuestrasTotal;
      const pesoSecoNeto = pesoNetoHumedo * (1 - lote.porcentaje_humedad / 100);

      await client.query(
        `INSERT INTO lotes 
          (carga_id, codigo_lote, peso_bruto, tara, peso_muestras_total, porcentaje_humedad, peso_seco_neto, pesos_muestras) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          cargaId,
          lote.codigo_lote,
          lote.peso_bruto,
          lote.tara,
          pesoMuestrasTotal,
          lote.porcentaje_humedad,
          pesoSecoNeto.toFixed(2),
          JSON.stringify(lote.pesos_muestras)
        ]
      );
    }

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error al guardar carga:', err);
    res.status(500).json({ success: false, error: 'Error al guardar el registro en la base de datos.' });
  } finally {
    client.release();
  }
});

// Endpoint: Actualizar estado de la carga
app.patch('/api/cargas/:id/estado', async (req, res) => {
  const { id } = req.params;
  const { estado, rol_usuario } = req.body;

  if (rol_usuario !== 'ADMIN' && rol_usuario !== 'SUPERVISOR') {
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

app.listen(port, () => {
  console.log(`Servidor ejecutándose en el puerto ${port}`);
});
