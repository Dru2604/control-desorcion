const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

const pool = new Pool({
  user: 'postgres',
  host: 'localhost',
  database: 'Acopio_db',
  password: 'UTP2026', // Tu contraseña de pgAdmin
  port: 5432,
});

// 1. Ruta Login (Valida usuario, password y devuelve su ROL)
app.post('/api/login', async (req, res) => {
  try {
    const { usuario, password } = req.body;
    const result = await pool.query(
      'SELECT id, usuario, nombre, rol FROM usuarios WHERE usuario = $1 AND password = $2',
      [usuario, password]
    );

    if (result.rows.length > 0) {
      res.json({ success: true, usuario: result.rows[0] });
    } else {
      res.status(401).json({ success: false, error: 'Credenciales inválidas' });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 2. Guardar Carga con sus Múltiples Lotes
app.post('/api/cargas', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { codigo_carga, proveedor, usuario_registro, lotes } = req.body;

    // Insertar Carga Master
    const cargaRes = await client.query(
      'INSERT INTO cargas (codigo_carga, proveedor, usuario_registro) VALUES ($1, $2, $3) RETURNING id;',
      [codigo_carga, proveedor, usuario_registro]
    );
    const cargaId = cargaRes.rows[0].id;

    // Insertar cada Lote
    for (const l of lotes) {
      const cantidad_muestras = l.pesos_muestras.length;
      const peso_muestras_total = l.pesos_muestras.reduce((a, b) => a + b, 0);
      const peso_humedo_neto = (l.peso_bruto - l.tara) - peso_muestras_total;
      const descuento_humedad_kg = peso_humedo_neto * (l.porcentaje_humedad / 100.0);
      const peso_seco_neto = peso_humedo_neto - descuento_humedad_kg;

      await client.query(
        `INSERT INTO lotes (carga_id, codigo_lote, peso_bruto, tara, cantidad_muestras, peso_muestras_total, peso_humedo_neto, porcentaje_humedad, descuento_humedad_kg, peso_seco_neto)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10);`,
        [cargaId, l.codigo_lote, l.peso_bruto, l.tara, cantidad_muestras, peso_muestras_total.toFixed(2), peso_humedo_neto.toFixed(2), l.porcentaje_humedad, descuento_humedad_kg.toFixed(2), peso_seco_neto.toFixed(2)]
      );
    }

    await client.query('COMMIT');
    res.json({ success: true, message: 'Carga y lotes registrados exitosamente' });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, error: error.message });
  } finally {
    client.release();
  }
});

// 3. Obtener Cargas e Historial Completo
app.get('/api/cargas', async (req, res) => {
  try {
    const cargasRes = await pool.query('SELECT * FROM cargas ORDER BY fecha DESC;');
    const cargas = cargasRes.rows;

    for (let c of cargas) {
      const lotesRes = await pool.query('SELECT * FROM lotes WHERE carga_id = $1;', [c.id]);
      c.lotes = lotesRes.rows;
    }

    res.json({ success: true, data: cargas });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 4. Editar Estado ('Por Liquidar' / 'Liquidado') - Solo ADMIN o SUPERVISOR
app.patch('/api/cargas/:id/estado', async (req, res) => {
  try {
    const { id } = req.params;
    const { estado, rol_usuario } = req.body;

    if (rol_usuario !== 'ADMIN' && rol_usuario !== 'SUPERVISOR') {
      return res.status(403).json({ success: false, error: 'No tienes permiso para modificar estados' });
    }

    await pool.query('UPDATE cargas SET estado = $1 WHERE id = $2;', [estado, id]);
    res.json({ success: true, message: 'Estado actualizado correctamente' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 5. Vaciar Historial - Solo ADMIN
app.delete('/api/cargas', async (req, res) => {
  try {
    const { rol_usuario } = req.body;
    if (rol_usuario !== 'ADMIN') {
      return res.status(403).json({ success: false, error: 'Solo el ADMIN puede eliminar historial' });
    }
    await pool.query('TRUNCATE TABLE cargas, lotes RESTART IDENTITY CASCADE;');
    res.json({ success: true, message: 'Historial borrado' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(3001, () => {
  console.log('Servidor listo en: http://localhost:3001');
});