require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const path = require('path');
const db = require('./db');
const cloudinary = require('cloudinary').v2;
const fs = require('fs');
const { DateTime } = require('luxon');
const MySQLStore = require('express-mysql-session')(session);
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const multer = require('multer');
const upload = multer({ dest: 'uploads/' }); // Carpeta temporal


const horaPeru = DateTime.now()
  .setZone('America/Lima')
  .toFormat("yyyy-MM-dd HH:mm:ss");
const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static('uploads'));

// Configuración del almacén de sesiones
const sessionStore = new MySQLStore({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT
});

// Configuración de express-session
app.use(session({
  secret: process.env.SESSION_SECRET, // Cambia esto por una cadena secreta segura
  resave: false,
  saveUninitialized: false,
  store: sessionStore // Usar el almacén de sesiones MySQL
}));

app.get('/', (req, res) => {
  res.render('login');
});

app.post('/login', (req, res) => {
  const { dni, contraseña } = req.body;

  db.query('SELECT * FROM usuario WHERE dni_usuario = ?', [dni], async (err, results) => {
    if (err) {
      console.error('Error al buscar usuario:', err);
      return res.render('login', { error: 'Error en el servidor. Intente nuevamente.' });
    }

    if (results.length > 0) {
      const user = results[0];
      const validPassword = contraseña === user.contraseña;

      if (validPassword) {
        if (user.tipo_usuario === 'eliminado') {
          return res.render('eliminado');
        }
        req.session.user = user;
        if (user.tipo_usuario === 'administrador') {
          return res.redirect('/admin');
        } else if (user.tipo_usuario === 'trabajador') {
          return res.redirect('/trabajador');
        } else {
          return res.render('login', { error: 'Tipo de usuario no reconocido.' });
        }
      } else {
        return res.render('login', { error: 'Contraseña incorrecta.' });
      }
    } else {
      return res.render('login', { error: 'Usuario no encontrado.' });
    }
  });
});

app.get('/admin', (req, res) => {
  if (req.session.user?.tipo_usuario === 'administrador') {
    res.render('admin', { user: req.session.user });
  } else {
    res.redirect('/');
  }
});

app.get('/admin2', (req, res) => {
  if (req.session.user?.tipo_usuario === 'administrador') {
    res.render('admin2', { user: req.session.user });
  } else {
    res.redirect('/');
  }
});

app.get('/trabajador', (req, res) => {
  if (req.session.user?.tipo_usuario === 'trabajador') {
    res.render('trabajador', { user: req.session.user });
  } else {
    res.redirect('/');
  }
});

app.get('/prestamo', (req, res) => {
  if (req.session.user?.tipo_usuario === 'trabajador') {
    res.render('prestamo', { user: req.session.user });
  } else {
    res.redirect('/');
  }
});

app.post('/prestamo', (req, res) => {
  console.log(req.body); // Verifica qué datos está recibiendo el servidor

  const { nombre_cliente, dni_cliente, telefono_cliente, direccion_cliente } = req.body;

  if (!nombre_cliente || !dni_cliente || !telefono_cliente || !direccion_cliente) {
    return res.json({ success: false, error: 'Todos los campos son obligatorios.' });
  }

  db.query(
    'SELECT * FROM cliente WHERE dni_cliente = ?',
    [dni_cliente],
    (err, results) => {
      if (err) {
        console.error('Error al buscar cliente:', err);
        return res.json({ success: false, error: 'Error al buscar cliente.' });
      }

      if (results.length > 0) {
        return res.json({ success: false, error: 'El DNI ya está registrado.' });
      }

      db.query(
        'INSERT INTO cliente (nombre_cliente, dni_cliente, telefono_cliente, direccion_cliente) VALUES (?, ?, ?, ?)',
        [nombre_cliente, dni_cliente, telefono_cliente, direccion_cliente],
        (err, result) => {
          if (err) {
            console.error('Error al registrar cliente:', err);
            return res.json({ success: false, error: 'Error al registrar cliente.' });
          }

          res.json({ success: true });
        }
      );
    }
  );
});

app.get('/historial', (req, res) => {
  if (req.session.user?.tipo_usuario === 'trabajador') {
    const idUsuario = req.session.user.id_usuario;

    // Obtener el inicio del día anterior en la zona horaria de Perú
    const ayer = DateTime.now().setZone('America/Lima').minus({ days: 1 }).startOf('day').toFormat('yyyy-MM-dd HH:mm:ss');

    db.query(`
      SELECT 
        pago.monto_pagado, 
        pago.fecha_pago, 
        cliente.nombre_cliente, 
        usuario.nombre_usuario AS nombre_trabajador
      FROM pago
      JOIN deuda ON pago.id_deuda = deuda.id_deuda
      JOIN cliente ON deuda.id_cliente = cliente.id_cliente
      JOIN usuario ON pago.id_usuario = usuario.id_usuario
      WHERE pago.id_usuario = ? 
        AND pago.fecha_pago >= ?
      ORDER BY pago.fecha_pago DESC
    `, [idUsuario, ayer], (err, resultados) => {
      if (err) {
        console.error('Error al recuperar los pagos:', err);
        return res.status(500).send('Error al recuperar los pagos');
      }

      res.render('historial', { pagos: resultados, DateTime, user: req.session.user });
    });
  } else {
    res.redirect('/');
  }
});


app.get('/api/cliente', (req, res) => {
  const dni = req.query.dni;

  db.query('SELECT * FROM cliente WHERE dni_cliente = ?', [dni], (err, clienteResults) => {
    if (err) return res.json({ success: false, error: err });

    if (clienteResults.length === 0) {
      return res.json({ success: false, message: 'Cliente no encontrado' });
    }

    const cliente = clienteResults[0];

    db.query('SELECT * FROM deuda WHERE id_cliente = ? AND monto_deuda > 0', [cliente.id_cliente], (err, deudaResults) => {

      if (err) return res.json({ success: false, error: err });

      res.json({ success: true, cliente, deudas: deudaResults });
    });
  });
});

app.post('/registrar-pago', upload.single('comprobante_pago'), async (req, res) => {
  const { id_deuda, monto_pagado, metodo_pago, id_usuario } = req.body;
  let comprobante = 'efectivo';

  if (metodo_pago === 'yape' && req.file) {
    try {
      console.log('Archivo recibido:', req.file);
      const result = await cloudinary.uploader.upload(req.file.path, {
        folder: 'comprobantes'
      });
      console.log('Resultado Cloudinary:', result);
      comprobante = result.secure_url;
      fs.unlinkSync(req.file.path);
    } catch (err) {
      console.error('Error Cloudinary:', err);
      return res.send('Error al subir la imagen a Cloudinary');
    }
  }
  

  db.query('SELECT monto_deuda FROM deuda WHERE id_deuda = ?', [id_deuda], (err, results) => {
    if (err) return res.send('Error al verificar la deuda');
    if (results.length === 0) return res.send('Deuda no encontrada');
    const montoActual = results[0].monto_deuda;
    const monto = parseFloat(monto_pagado);

    if (monto <= 0) return res.send('El monto debe ser mayor a 0');
    if (monto > montoActual) return res.send(`El monto pagado (S/.${monto}) no puede ser mayor a la deuda actual (S/.${montoActual})`);

    db.query('INSERT INTO pago (id_deuda, id_usuario, monto_pagado, fecha_pago, comprobante_pago) VALUES (?, ?, ?, ?, ?)',
      [id_deuda, id_usuario, monto_pagado, horaPeru, comprobante], (err2, result) => {
        if (err2) return res.send('Error al registrar el pago');

        db.query('UPDATE deuda SET monto_deuda = monto_deuda - ? WHERE id_deuda = ?', [monto_pagado, id_deuda], (err3) => {
          if (err3) return res.send('Error al actualizar la deuda');
          res.send(`OK:${result.insertId}`);
        });
      });
  });
});


app.get('/comprobante', (req, res) => {
  const id_pago = req.query.id_pago;

  db.query(`
    SELECT pago.*, cliente.nombre_cliente, cliente.dni_cliente, deuda.monto_deuda
    FROM pago
    JOIN deuda ON pago.id_deuda = deuda.id_deuda
    JOIN cliente ON deuda.id_cliente = cliente.id_cliente
    WHERE pago.id_pago = ?`,
    [id_pago], (err, results) => {
      if (err) throw err;

      if (results.length === 0) return res.send("Pago no encontrado.");

      const pago = results[0];
      res.render('comprobante', { pago });
    });
});
// Ruta para renderizar la vista de agregar deuda
app.get('/deuda', (req, res) => {
  if (req.session.user?.tipo_usuario === 'trabajador') {
    res.render('deuda', { user: req.session.user });
  } else {
    res.redirect('/');
  }
});

// Ruta para registrar una nueva deuda
app.post('/deuda', (req, res) => {
  const { id_cliente, monto_deuda, descripcion_deuda, id_usuario } = req.body;

  if (!id_cliente) {
    return res.render('deuda', {
      user: req.session.user,
      error: 'Cliente no encontrado. Verifique el DNI.'
    });
  }

  const monto = parseFloat(monto_deuda);
  if (isNaN(monto) || monto <= 0) {
    return res.render('deuda', {
      user: req.session.user,
      error: 'El monto de la préstamo debe ser mayor a 0.'
    });
  }

  const fechaDeuda = DateTime.now().setZone('America/Lima').toFormat('yyyy-MM-dd HH:mm:ss');

  db.query(
    'INSERT INTO deuda (id_cliente, id_usuario, monto_inicial, monto_deuda, descripcion_deuda, fecha_deuda) VALUES (?, ?, ?, ?, ?, ?)',
    [id_cliente, id_usuario, monto, monto, descripcion_deuda, fechaDeuda],
    (err, result) => {
      if (err) {
        console.error('Error al registrar la deuda:', err);
        return res.render('deuda', {
          user: req.session.user,
          error: 'Error al registrar la deuda. Intente nuevamente.'
        });
      }

      res.render('deuda', {
        user: req.session.user,
        success: 'Préstamo registrada correctamente.'
      });
    }
  );
});

app.get('/api/clientes-deudas', (req, res) => {
  const dni = req.query.dni;

  let query = `
    SELECT cliente.nombre_cliente, deuda.monto_inicial, deuda.monto_deuda
    FROM cliente
    LEFT JOIN deuda ON cliente.id_cliente = deuda.id_cliente
  `;
  const params = [];

  if (dni) {
    query += ' WHERE cliente.dni_cliente = ?';
    params.push(dni);
  }

  db.query(query, params, (err, resultados) => {
    if (err) {
      console.error('Error al obtener clientes y deudas:', err);
      return res.json({ success: false, error: 'Error al obtener datos' });
    }

    res.json({ success: true, resultados });
  });
});

// Ruta para la vista de Clientes y Deudas
app.get('/clientes-deudas', (req, res) => {
  if (req.session.user?.tipo_usuario === 'administrador') {
    res.render('clientes-deudas', { user: req.session.user });
  } else {
    res.redirect('/');
  }
});

// Rutas para las otras opciones (por ahora en blanco)
app.get('/op2', (req, res) => {
  if (req.session.user?.tipo_usuario === 'administrador') {
    res.send('<h1>Opción 2</h1>');
  } else {
    res.redirect('/');
  }
});

app.get('/op3', (req, res) => {
  if (req.session.user?.tipo_usuario === 'administrador') {
    res.send('<h1>Opción 3</h1>');
  } else {
    res.redirect('/');
  }
});

app.get('/op4', (req, res) => {
  if (req.session.user?.tipo_usuario === 'administrador') {
    res.send('<h1>Opción 4</h1>');
  } else {
    res.redirect('/');
  }
});

// Vista principal de pagos del día (solo administrador)
app.get('/pagosdia', (req, res) => {
  if (req.session.user?.tipo_usuario === 'administrador') {
    res.render('pagosdia', { user: req.session.user, horaPeru });
  } else {
    res.redirect('/');
  }
});

// API para obtener pagos filtrados (solo administrador)
app.get('/api/pagosdia', (req, res) => {
  if (req.session.user?.tipo_usuario !== 'administrador') {
    return res.status(403).json({ success: false, error: 'No autorizado' });
  }

  const { dni, fecha } = req.query;
  let query = `
    SELECT cliente.nombre_cliente, usuario.nombre_usuario, pago.monto_pagado, deuda.monto_deuda, pago.fecha_pago
    FROM pago
    JOIN deuda ON pago.id_deuda = deuda.id_deuda
    JOIN cliente ON deuda.id_cliente = cliente.id_cliente
    JOIN usuario ON pago.id_usuario = usuario.id_usuario
    WHERE 1=1
  `;
  const params = [];

  // Si el usuario ingresó un DNI (usuario)
  if (dni && dni.trim() !== '') {
    query += ' AND usuario.dni_usuario = ?';
    params.push(dni);
  }

  // Si el usuario ingresó una fecha válida
  if (fecha && fecha.trim() !== '') {
    const regex = /^(\d{2})\/(\d{2})\/(\d{4})$/;
    const match = fecha.match(regex);
    if (!match) {
      return res.json({ success: false, error: 'Formato de fecha incorrecto. Use dd/mm/yyyy.' });
    }
    const fechaFiltro = `${match[3]}-${match[2]}-${match[1]}`;
    query += ' AND DATE(pago.fecha_pago) = ?';
    params.push(fechaFiltro);
  }

  // Si no hay filtros, mostrar solo los pagos del día actual
  if ((!dni || dni.trim() === '') && (!fecha || fecha.trim() === '')) {
    const fechaHoy = DateTime.now().setZone('America/Lima').toFormat('yyyy-MM-dd');
    query += ' AND DATE(pago.fecha_pago) = ?';
    params.push(fechaHoy);
  }

  db.query(query, params, (err, resultados) => {
    if (err) {
      console.error('Error al obtener pagos del día:', err);
      return res.json({ success: false, error: 'Error al obtener datos' });
    }
    res.json({ success: true, resultados });
  });
});

app.post('/agregar-cliente', (req, res) => {
  if (req.session.user?.tipo_usuario !== 'administrador') {
    return res.status(403).json({ success: false, error: 'No autorizado' });
  }

  const { nombre_cliente, dni_cliente, telefono_cliente, direccion_cliente } = req.body;

  if (!nombre_cliente || !dni_cliente || !telefono_cliente || !direccion_cliente) {
    return res.json({ success: false, error: 'Todos los campos son obligatorios.' });
  }

  // Validar que el DNI tenga exactamente 8 dígitos numéricos
  if (!/^\d{8}$/.test(dni_cliente)) {
    return res.json({ success: false, error: 'El DNI debe tener exactamente 8 dígitos numéricos.' });
  }

  db.query(
    'SELECT * FROM cliente WHERE dni_cliente = ?',
    [dni_cliente],
    (err, results) => {
      if (err) {
        console.error('Error al buscar cliente:', err);
        return res.json({ success: false, error: 'Error al buscar cliente.' });
      }

      if (results.length > 0) {
        return res.json({ success: false, error: 'El DNI ya está registrado.' });
      }

      db.query(
        'INSERT INTO cliente (nombre_cliente, dni_cliente, telefono_cliente, direccion_cliente) VALUES (?, ?, ?, ?)',
        [nombre_cliente, dni_cliente, telefono_cliente, direccion_cliente],
        (err, result) => {
          if (err) {
            console.error('Error al registrar cliente:', err);
            return res.json({ success: false, error: 'Error al registrar cliente.' });
          }

          res.json({ success: true });
        }
      );
    }
  );
});

app.get('/agregar-cliente', (req, res) => {
  if (req.session.user?.tipo_usuario === 'administrador') {
    res.render('agregar-cliente', { user: req.session.user });
  } else {
    res.redirect('/');
  }
});

app.get('/eliminar-cliente', (req, res) => {
  if (req.session.user?.tipo_usuario === 'administrador') {
    res.render('eliminar-cliente', { user: req.session.user });
  } else {
    res.redirect('/');
  }
});

app.post('/eliminar-cliente', (req, res) => {
  if (req.session.user?.tipo_usuario !== 'administrador') {
    return res.status(403).json({ success: false, error: 'No autorizado' });
  }

  const { dni_cliente } = req.body;

  if (!dni_cliente || !/^\d{8}$/.test(dni_cliente)) {
    return res.json({ success: false, error: 'El DNI debe tener exactamente 8 dígitos numéricos.' });
  }

  // Solo elimina el cliente, no borra deudas ni pagos relacionados
  db.query('DELETE FROM cliente WHERE dni_cliente = ?', [dni_cliente], (err, result) => {
    if (err) {
      // Si hay error por restricción de clave foránea, muestra mensaje personalizado
      if (err.code === 'ER_ROW_IS_REFERENCED_2') {
        return res.json({ success: false, error: 'No se puede eliminar el cliente porque tiene deudas o pagos asociados.' });
      }
      console.error('Error al eliminar cliente:', err);
      return res.json({ success: false, error: 'Error al eliminar cliente.' });
    }
    if (result.affectedRows === 0) {
      return res.json({ success: false, error: 'Cliente no encontrado.' });
    }
    res.json({ success: true });
  });
});

// Vista para eliminar usuario
app.get('/eliminar-usuario', (req, res) => {
  if (req.session.user?.tipo_usuario === 'administrador') {
    res.render('eliminar-usuario', { user: req.session.user });
  } else {
    res.redirect('/');
  }
});

// POST para marcar usuario como eliminado
app.post('/eliminar-usuario', (req, res) => {
  if (req.session.user?.tipo_usuario !== 'administrador') {
    return res.status(403).json({ success: false, error: 'No autorizado' });
  }

  const { dni_usuario } = req.body;

  if (!dni_usuario || !/^\d{8}$/.test(dni_usuario)) {
    return res.json({ success: false, error: 'El DNI debe tener exactamente 8 dígitos numéricos.' });
  }

  db.query(
    'UPDATE usuario SET tipo_usuario = "eliminado" WHERE dni_usuario = ?',
    [dni_usuario],
    (err, result) => {
      if (err) {
        console.error('Error al eliminar usuario:', err);
        return res.json({ success: false, error: 'Error al eliminar usuario.' });
      }
      if (result.affectedRows === 0) {
        return res.json({ success: false, error: 'Usuario no encontrado.' });
      }
      res.json({ success: true });
    }
  );
});

// Vista para usuario eliminado
app.get('/eliminado', (req, res) => {
  res.render('eliminado');
});

app.get('/agregar-usuario', (req, res) => {
  if (req.session.user?.tipo_usuario === 'administrador') {
    res.render('agregar-usuario', { user: req.session.user });
  } else {
    res.redirect('/');
  }
});

app.post('/agregar-usuario', (req, res) => {
  if (req.session.user?.tipo_usuario !== 'administrador') {
    return res.status(403).json({ success: false, error: 'No autorizado' });
  }

  const { dni_usuario, nombre_usuario, tipo_usuario, contraseña } = req.body;

  if (!dni_usuario || !nombre_usuario || !tipo_usuario || !contraseña) {
    return res.json({ success: false, error: 'Todos los campos son obligatorios.' });
  }

  if (!/^\d{8}$/.test(dni_usuario)) {
    return res.json({ success: false, error: 'El DNI debe tener exactamente 8 dígitos numéricos.' });
  }

  if (nombre_usuario.length < 3) {
    return res.json({ success: false, error: 'El nombre debe tener al menos 3 caracteres.' });
  }

  if (contraseña.length < 4) {
    return res.json({ success: false, error: 'La contraseña debe tener al menos 4 caracteres.' });
  }

  db.query(
    'SELECT * FROM usuario WHERE dni_usuario = ?',
    [dni_usuario],
    (err, results) => {
      if (err) {
        console.error('Error al buscar usuario:', err);
        return res.json({ success: false, error: 'Error al buscar usuario.' });
      }

      if (results.length > 0) {
        return res.json({ success: false, error: 'El DNI ya está registrado.' });
      }

      db.query(
        'INSERT INTO usuario (dni_usuario, nombre_usuario, tipo_usuario, contraseña) VALUES (?, ?, ?, ?)',
        [dni_usuario, nombre_usuario, tipo_usuario, contraseña],
        (err, result) => {
          if (err) {
            console.error('Error al registrar usuario:', err);
            return res.json({ success: false, error: 'Error al registrar usuario.' });
          }

          res.json({ success: true });
        }
      );
    }
  );
});

app.listen(PORT, () => {
  console.log(`Servidor iniciado en http://localhost:${PORT}`);
});
