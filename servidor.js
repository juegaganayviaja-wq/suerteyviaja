servidor


// servidor.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// === CORS: dominios SIN espacios ni barras ===
app.use(cors({
  origin: [
    'http://localhost:3000',
    'https://viajaydisfruta.onrender.com',   // ✅ sin espacios
    'https://suerteyviaja.netlify.app'       // ✅ sin espacios
  ]
}));

app.use(express.json({ limit: '10mb' }));

// === SERVE ARCHIVOS ESTÁTICOS (frontend) ===
app.use(express.static(path.join(__dirname, 'public')));

// === SUPABASE ===
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// === RESEND ===
const resend = new Resend(process.env.RESEND_API_KEY);

// === RUTA RAÍZ: sirve index.html ===
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// === RUTA DE SALUD ===
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', message: 'Backend funcionando.' });
});

// // === OBTENER NÚMEROS OCUPADOS ===
app.get('/api/ocupados', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('participaciones')
      .select('numeros, estado, timestamp');
    if (error) throw error;

    const TREINTA_MINUTOS = 30 * 60 * 1000;
    const ahora = Date.now();
    const ocupados = new Set(
      data
        .filter(p => 
          p.estado === 'confirmado' || 
          (p.estado === 'pendiente' && p.timestamp > ahora - TREINTA_MINUTOS)
          // ⚠️ Los rechazados NO se incluyen → se liberan inmediatamente
        )
        .flatMap(p => p.numeros || [])
    );
    res.json({ numeros: [...ocupados] });
  } catch (err) {
    console.error('❌ Error al obtener números ocupados:', err);
    res.status(500).json({ error: 'Error al obtener números ocupados.' });
  }
});

// === FUNCIÓN PARA ENVIAR CORREO ===
async function enviarCorreo(to, subject, html) {
  try {
    await resend.emails.send({
      from: 'Gana y Viaja <juegaganayviaja@gmail.com>',
      to,
      subject,
      html
    });
    console.log('✅ Correo enviado a:', to);
  } catch (err) {
    console.error('❌ Error al enviar correo:', err);
    throw new Error('No se pudo enviar el correo.');
  }
}

// === REGISTRAR PARTICIPACIÓN ===


// Verificar referencia duplicada
const { data: existente, error: refError } = await supabase
  .from('participaciones')
  .select('referencia')
  .eq('referencia', referencia)
  .single();

if (refError?.code !== 'PGRST116') { // PGRST116 = "no rows returned"
  return res.status(409).json({ error: 'La referencia de pago ya ha sido utilizada.' });
}

app.post('/api/reservar', async (req, res) => {
  const { nombre, telefono, correo, numeros, referencia, fecha, timestamp } = req.body;
  if (!nombre || !telefono || !correo || !referencia || !fecha || !timestamp || !Array.isArray(numeros) || numeros.length < 2) {
    return res.status(400).json({ error: 'Faltan datos o números insuficientes.' });
  }

  try {
    const { data: todas, error: errCheck } = await supabase
      .from('participaciones')
      .select('numeros');
    if (errCheck) throw errCheck;

    const ocupados = new Set(todas.flatMap(p => p.numeros || []));
    const repetidos = numeros.filter(n => ocupados.has(n));
    if (repetidos.length > 0) {
      return res.status(409).json({ error: `Números ya usados: ${repetidos.join(', ')}` });
    }

    const { data, error } = await supabase
      .from('participaciones')
      .insert([{ nombre, telefono, correo, numeros, referencia, fecha, estado: 'pendiente', timestamp }])
      .select();
    if (error) throw error;

    await enviarCorreo(
      correo,
      '📄 Comprobante recibido - Pendiente de validación',
      `<h2>📄 ¡Tu comprobante ha sido recibido!</h2>
       <p>Hola <strong>${nombre}</strong>,</p>
       <p>Hemos recibido tu comprobante de pago. Nuestro equipo lo está revisando.</p>
       <p><strong>Números jugados:</strong> ${numeros.map(n => `<span style="background:#e3f2fd; padding:4px 8px; border-radius:4px; margin:2px;">${n}</span>`).join(' ')}</p>
       <p>Te notificaremos cuando tu participación sea validada.</p>
       <p>Gracias por participar en <strong>Gana y Viaja</strong> 🎉</p>`
    );

    res.status(201).json({ id: data[0].id });
  } catch (err) {
    console.error('❌ Error al registrar:', err);
    res.status(500).json({ error: 'Error al registrar participación.' });
  }
});

// === VALIDAR PARTICIPACIÓN ===
app.post('/api/participacion/:id/validar', async (req, res) => {
  const { id } = req.params;
  try {
    const { data: participacion, error: fetchError } = await supabase
      .from('participaciones')
      .select('*')
      .eq('id', id)
      .single();
    if (fetchError || !participacion) {
      return res.status(404).json({ error: 'Participación no encontrada.' });
    }
    if (participacion.estado === 'confirmado') {
      return res.status(400).json({ error: 'Ya validada.' });
    }

    const { error: updateError } = await supabase
      .from('participaciones')
      .update({ estado: 'confirmado' })
      .eq('id', id);
    if (updateError) throw updateError;

    await enviarCorreo(
      participacion.correo,
      '✅ ¡Tu participación ha sido validada!',
      `<h2>✅ ¡Tu participación ha sido validada!</h2>
       <p>Hola <strong>${participacion.nombre}</strong>,</p>
       <p>Tus números están confirmados:</p>
       <p><strong>Números:</strong> ${participacion.numeros.map(n => `<span style="background:#1976d2; color:white; padding:4px 8px; border-radius:4px; margin:2px;">${n}</span>`).join(' ')}</p>
       <p>¡Mucha suerte en el sorteo!</p>
       <p>Equipo de <strong>Gana y Viaja</strong></p>`
    );

    res.json({ success: true, message: 'Participación validada.' });
  } catch (err) {
    console.error('❌ Error al validar:', err);
    res.status(500).json({ error: 'Error al validar la participación.' });
  }
});

// === RECHAZAR PARTICIPACIÓN ===
app.post('/api/participacion/:id/rechazar', async (req, res) => {
  const { id } = req.params;
  try {
    const { data: participacion, error: fetchError } = await supabase
      .from('participaciones')
      .select('*')
      .eq('id', id)
      .single();
    if (fetchError || !participacion) {
      return res.status(404).json({ error: 'Participación no encontrada.' });
    }
    if (participacion.estado === 'confirmado') {
      return res.status(400).json({ error: 'No se puede rechazar una participación ya validada.' });
    }

    const { error: updateError } = await supabase
      .from('participaciones')
      .update({ estado: 'rechazado' })
      .eq('id', id);
    if (updateError) throw updateError;

    await enviarCorreo(
      participacion.correo,
      '⚠️ Tu participación no pudo ser validada',
      `<h2>⚠️ Tu participación no pudo ser validada</h2>
       <p>Hola <strong>${participacion.nombre}</strong>,</p>
       <p>Lamentamos informarte que tu comprobante no pudo ser verificado.</p>
       <p>Si crees que es un error, envía nuevamente el comprobante desde la página web.</p>
       <p>Gracias por tu interés.</p>
       <p>Equipo de <strong>Gana y Viaja</strong></p>`
    );

    res.json({ success: true, message: 'Participación rechazada.' });
  } catch (err) {
    console.error('❌ Error al rechazar:', err);
    res.status(500).json({ error: 'Error al rechazar la participación.' });
  }
});

// === MANEJO DE ERRORES GLOBAL ===
app.use((err, req, res, next) => {
  console.error('Error no capturado:', err);
  res.status(500).json({ error: 'Error interno del servidor.' });
});

// === OBTENER TODAS LAS PARTICIPACIONES (para admin) ===
app.get('/api/participaciones', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('participaciones')
      .select('*')
      .order('timestamp', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('❌ Error al obtener participaciones:', err);
    res.status(500).json({ error: 'Error al obtener participaciones.' });
  }
});



// === LOGIN DE ADMINISTRADOR ===
app.post('/api/admin/login', async (req, res) => {
  const { password } = req.body;
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
  
  if (password === ADMIN_PASSWORD) {
    // Genera un token de sesión simple
    const token = 'admin-session-' + Date.now();
    res.json({ success: true, token });
  } else {
    res.status(401).json({ error: 'Contraseña incorrecta' });
  }
});

// === INICIAR SERVIDOR ===
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Backend corriendo en puerto ${PORT}`);
  console.log(`🔗 URL pública: https://viajaydisfruta.onrender.com`);
});
