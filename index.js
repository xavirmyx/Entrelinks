const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const cron = require('node-cron');
const fs = require('fs');
const axios = require('axios');

// Token del bot (usa tu token actual de Telegram)
const token = '7861676131:AAFLv4dBIFiHV1OYc8BJH2U8kWPal7lpBMQ';
const bot = new TelegramBot(token);

// Configuración del servidor Express
const app = express();
const port = process.env.PORT || 10000;

// Middleware para parsear JSON
app.use(express.json());

// Configuración del webhook
const webhookUrl = 'https://entrelinks.onrender.com'; // Ajusta si tu URL de Render cambia

// IDs permitidos
const ALLOWED_CHAT_ID = '-1002348662107';
const ALLOWED_THREAD_ID = '53411'; // Thread del canal

// Almacenar datos
let userHistory = {}; // { userId: [{ url, result, timestamp }] }
let alerts = {}; // { userId: { url, expiresAt, notifyDaysBefore } }
const logsFile = 'bot_logs.json';

// Inicializar el archivo de logs si no existe
if (!fs.existsSync(logsFile)) {
  fs.writeFileSync(logsFile, JSON.stringify([]));
}

// Función para registrar una acción en el archivo de logs
function logAction(action, details) {
  const logs = JSON.parse(fs.readFileSync(logsFile));
  const timestamp = new Date().toLocaleString('es-ES');
  logs.push({ action, details, timestamp });
  fs.writeFileSync(logsFile, JSON.stringify(logs, null, 2));
}

// Ruta para el webhook
app.post(`/bot${token}`, (req, res) => {
  console.log('📩 Recibida actualización de Telegram:', JSON.stringify(req.body));
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Ruta para la raíz (/)
app.get('/', (req, res) => {
  res.send('EntreCheck_iptv is running');
});

// Iniciar el servidor
app.listen(port, async () => {
  console.log(`🚀 Servidor escuchando en el puerto ${port}`);
  await setWebhookWithRetry();
});

// Configurar el webhook con manejo de errores 429
async function setWebhookWithRetry() {
  try {
    console.log(`Configurando webhook: ${webhookUrl}/bot${token}`);
    await bot.setWebHook(`${webhookUrl}/bot${token}`);
    console.log(`✅ Webhook configurado: ${webhookUrl}/bot${token}`);
  } catch (error) {
    if (error.response && error.response.status === 429) {
      const retryAfter = error.response.data.parameters.retry_after || 1;
      console.warn(`⚠️ Error 429 Too Many Requests. Reintentando después de ${retryAfter} segundos...`);
      await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
      return setWebhookWithRetry();
    }
    console.error(`❌ Error al configurar webhook: ${error.message}`);
  }
}

// Función para verificar si el mensaje proviene del canal y thread permitidos
function isAllowedContext(chatId, threadId) {
  return String(chatId) === ALLOWED_CHAT_ID && String(threadId) === ALLOWED_THREAD_ID;
}

// Función para verificar listas IPTV
async function checkIPTVList(url) {
  try {
    if (url.includes('get.php')) { // Xtream Codes
      const [, params] = url.split('?');
      const { username, password } = Object.fromEntries(new URLSearchParams(params));
      const server = url.split('/get.php')[0];
      const apiUrl = `${server}/player_api.php?username=${username}&password=${password}`;
      const response = await axios.get(apiUrl, { timeout: 5000 });
      const { user_info } = response.data;

      const quality = user_info.max_connections > 1 ? '1080p (estable)' : '720p (posible buffering)';
      return {
        type: 'Xtream Codes',
        status: user_info.status,
        username: user_info.username,
        password: user_info.password,
        server: server,
        createdAt: new Date(user_info.created_at * 1000).toLocaleString('es-ES'),
        expiresAt: new Date(user_info.exp_date * 1000).toLocaleString('es-ES'),
        maxConnections: user_info.max_connections,
        activeConnections: user_info.active_cons,
        channels: (await axios.get(`${apiUrl}&action=get_live_streams`)).data.length,
        quality,
        risk: server.includes('suspicious') ? 'Posible riesgo detectado' : 'Sin riesgos aparentes'
      };
    } else if (url.endsWith('.m3u') || url.endsWith('.m3u8')) { // M3U/M3U8
      const response = await axios.get(url, { timeout: 5000 });
      const lines = response.data.split('\n');
      const channels = lines.filter(line => line.startsWith('#EXTINF')).length;
      const quality = channels > 100 ? '1080p (alta carga)' : '720p (estándar)';
      return {
        type: 'M3U/M3U8',
        status: channels > 0 ? 'Activa' : 'Inactiva',
        channels,
        quality,
        risk: url.includes('suspicious') ? 'Posible riesgo detectado' : 'Sin riesgos aparentes'
      };
    } else { // Enlace directo
      const response = await axios.head(url, { timeout: 5000 });
      const quality = response.headers['content-length'] > 1000000 ? '1080p' : 'SD';
      return {
        type: 'Direct Link',
        status: response.status === 200 ? 'Activa' : 'Inactiva',
        quality,
        risk: url.includes('suspicious') ? 'Posible riesgo detectado' : 'Sin riesgos aparentes'
      };
    }
  } catch (error) {
    return { type: 'Desconocido', status: 'Error', error: error.message };
  }
}

// Generar barra de progreso
function generateProgressBar(progress, total) {
  const barLength = 20;
  const filled = Math.round((progress / total) * barLength);
  const empty = barLength - filled;
  return `📊 [${'█'.repeat(filled)}${'-'.repeat(empty)}] ${Math.round((progress / total) * 100)}%`;
}

// Menú principal con botones
const mainMenu = {
  inline_keyboard: [
    [
      { text: '🔍 Verificar Lista', callback_data: 'verificar' },
      { text: '📦 Verificar Múltiples', callback_data: 'masivo' }
    ],
    [
      { text: '📜 Historial', callback_data: 'historial' },
      { text: '⏰ Alerta', callback_data: 'alerta' }
    ],
    [
      { text: '📤 Exportar', callback_data: 'exportar' },
      { text: '📺 Filtrar Canales', callback_data: 'filtrar' }
    ]
  ]
};

// Comando /iptv: Menú principal
bot.onText(/\/iptv/, async (msg) => {
  const chatId = msg.chat.id;
  const threadId = msg.message_thread_id || '0';
  if (!isAllowedContext(chatId, threadId)) {
    await bot.sendMessage(chatId, `🚫 Este bot solo funciona en el canal oficial: https://t.me/c/2348662107/53411\n\n📢 *Grupos Entre Hijos*`, {
      message_thread_id: threadId
    });
    return;
  }

  const welcomeMessage = `👋 ¡Bienvenido a *EntreCheck_iptv*! 👋\n\n` +
    `Selecciona una opción para gestionar tus listas IPTV:\n\n` +
    `📢 *Grupos Entre Hijos*`;
  await bot.sendMessage(chatId, welcomeMessage, {
    parse_mode: 'Markdown',
    reply_markup: mainMenu,
    message_thread_id: ALLOWED_THREAD_ID
  });
});

// Manejo de botones y subcomandos
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const threadId = query.message.message_thread_id || '0';
  const userId = query.from.id;

  if (!isAllowedContext(chatId, threadId)) {
    await bot.sendMessage(chatId, `🚫 Este bot solo funciona en el canal oficial: https://t.me/c/2348662107/53411\n\n📢 *Grupos Entre Hijos*`, {
      message_thread_id: threadId
    });
    return;
  }

  const action = query.data;

  if (action === 'verificar') {
    await bot.sendMessage(chatId, `🔍 Escribe la URL de la lista IPTV que deseas verificar:\nEjemplo: http://servidor.com/get.php?username=xxx&password=yyy\n\n📢 *Grupos Entre Hijos*`, {
      message_thread_id: ALLOWED_THREAD_ID,
      reply_markup: { inline_keyboard: [[{ text: '⬅️ Retroceder', callback_data: 'volver' }]] }
    });
  } else if (action === 'masivo') {
    await bot.sendMessage(chatId, `📦 Escribe las URLs de las listas IPTV separadas por comas:\nEjemplo: url1, url2, url3\n\n📢 *Grupos Entre Hijos*`, {
      message_thread_id: ALLOWED_THREAD_ID,
      reply_markup: { inline_keyboard: [[{ text: '⬅️ Retroceder', callback_data: 'volver' }]] }
    });
  } else if (action === 'historial') {
    if (!userHistory[userId] || userHistory[userId].length === 0) {
      await bot.sendMessage(chatId, `ℹ️ No tienes historial de verificaciones.\n\n📢 *Grupos Entre Hijos*`, {
        message_thread_id: ALLOWED_THREAD_ID,
        reply_markup: { inline_keyboard: [[{ text: '⬅️ Retroceder', callback_data: 'volver' }]] }
      });
    } else {
      const historyMessage = `📜 Historial (últimas 5):\n\n` +
        userHistory[userId].slice(-5).map(h =>
          `📡 ${h.url}\nEstado: ${h.result.status}\n⏰ ${h.timestamp.toLocaleString('es-ES')}\n`
        ).join('\n') +
        `\n📢 *Grupos Entre Hijos*`;
      await bot.sendMessage(chatId, historyMessage, {
        parse_mode: 'Markdown',
        message_thread_id: ALLOWED_THREAD_ID,
        reply_markup: { inline_keyboard: [[{ text: '⬅️ Retroceder', callback_data: 'volver' }]] }
      });
    }
  } else if (action === 'alerta') {
    await bot.sendMessage(chatId, `⏰ Escribe la URL y los días antes de avisar:\nEjemplo: http://servidor.com/get.php?username=xxx&password=yyy 3\n\n📢 *Grupos Entre Hijos*`, {
      message_thread_id: ALLOWED_THREAD_ID,
      reply_markup: { inline_keyboard: [[{ text: '⬅️ Retroceder', callback_data: 'volver' }]] }
    });
  } else if (action === 'exportar') {
    await bot.sendMessage(chatId, `📤 Escribe la URL de la lista IPTV a exportar:\nEjemplo: http://servidor.com/get.php?username=xxx&password=yyy\n\n📢 *Grupos Entre Hijos*`, {
      message_thread_id: ALLOWED_THREAD_ID,
      reply_markup: { inline_keyboard: [[{ text: '⬅️ Retroceder', callback_data: 'volver' }]] }
    });
  } else if (action === 'filtrar') {
    await bot.sendMessage(chatId, `📺 Escribe la URL y la categoría a filtrar:\nEjemplo: http://servidor.com/get.php?username=xxx&password=yyy deportes\n\n📢 *Grupos Entre Hijos*`, {
      message_thread_id: ALLOWED_THREAD_ID,
      reply_markup: { inline_keyboard: [[{ text: '⬅️ Retroceder', callback_data: 'volver' }]] }
    });
  } else if (action === 'volver') {
    await bot.editMessageText(`👋 ¡Bienvenido a *EntreCheck_iptv*! 👋\n\nSelecciona una opción:\n\n📢 *Grupos Entre Hijos*`, {
      chat_id: chatId,
      message_id: query.message.message_id,
      parse_mode: 'Markdown',
      reply_markup: mainMenu
    });
  }

  await bot.answerCallbackQuery(query.id);
});

// Respuesta a mensajes después de seleccionar una opción
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const threadId = msg.message_thread_id || '0';
  const userId = msg.from.id;

  if (!isAllowedContext(chatId, threadId) || !msg.reply_to_message || msg.text.startsWith('/')) return;

  const replyText = msg.reply_to_message.text;

  // Verificar Lista
  if (replyText.includes('🔍 Escribe la URL')) {
    const url = msg.text;
    const checkingMessage = await bot.sendMessage(chatId, `🔍 Verificando ${url}...\n${generateProgressBar(0, 1)}`, {
      message_thread_id: ALLOWED_THREAD_ID
    });
    const result = await checkIPTVList(url);

    if (!userHistory[userId]) userHistory[userId] = [];
    userHistory[userId].push({ url, result, timestamp: new Date() });

    const responseMessage = `✅ Resultado:\n\n` +
      `📡 Tipo: ${result.type}\n` +
      `Estado: ${result.status}\n` +
      (result.username ? `👤 Usuario: ${result.username}\n🔑 Contraseña: ${result.password}\n🌐 Servidor: ${result.server}\n` : '') +
      (result.createdAt ? `📅 Creada: ${result.createdAt}\n⏰ Expira: ${result.expiresAt}\n` : '') +
      (result.channels ? `📺 Canales: ${result.channels}\n` : '') +
      (result.maxConnections ? `🔗 Conexiones máx.: ${result.maxConnections}\n🔌 Activas: ${result.activeConnections}\n` : '') +
      `📽 Calidad: ${result.quality || 'Desconocida'}\n` +
      `⚠️ Riesgo: ${result.risk || 'Sin datos'}\n` +
      (result.error ? `❌ Error: ${result.error}\n` : '') +
      `\n📢 *Grupos Entre Hijos*`;

    await bot.editMessageText(responseMessage, {
      chat_id: chatId,
      message_id: checkingMessage.message_id,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '⬅️ Retroceder', callback_data: 'volver' }]] }
    });
    logAction('verificar', { userId, url, status: result.status });
  }

  // Verificar Múltiples
  if (replyText.includes('📦 Escribe las URLs')) {
    const urls = msg.text.split(',').map(url => url.trim());
    const total = urls.length;
    const progressMessage = await bot.sendMessage(chatId, `📦 Verificando ${total} listas...\n${generateProgressBar(0, total)}`, {
      message_thread_id: ALLOWED_THREAD_ID
    });
    let processed = 0;
    let results = [];

    for (const url of urls) {
      const result = await checkIPTVList(url);
      results.push({ url, status: result.status });
      processed++;
      await bot.editMessageText(
        `📦 Progreso: ${processed}/${total}\n${generateProgressBar(processed, total)}`,
        { chat_id: chatId, message_id: progressMessage.message_id }
      );
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    if (!userHistory[userId]) userHistory[userId] = [];
    userHistory[userId].push(...results.map(r => ({ url: r.url, result: { status: r.status }, timestamp: new Date() })));

    const finalMessage = `✅ Resultados:\n\n` +
      results.map(r => `📡 ${r.url}: ${r.status}`).join('\n') +
      `\n\n📢 *Grupos Entre Hijos*`;
    await bot.editMessageText(finalMessage, {
      chat_id: chatId,
      message_id: progressMessage.message_id,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '⬅️ Retroceder', callback_data: 'volver' }]] }
    });
    logAction('masivo', { userId, urls, processed });
  }

  // Alerta
  if (replyText.includes('⏰ Escribe la URL')) {
    const [url, daysBefore] = msg.text.split(' ');
    const days = parseInt(daysBefore);
    const result = await checkIPTVList(url);

    if (result.expiresAt) {
      alerts[userId] = { url, expiresAt: new Date(result.expiresAt), notifyDaysBefore: days };
      await bot.sendMessage(chatId, `⏰ Alerta configurada para ${url}. Te avisaré ${days} días antes.\n\n📢 *Grupos Entre Hijos*`, {
        message_thread_id: ALLOWED_THREAD_ID,
        reply_markup: { inline_keyboard: [[{ text: '⬅️ Retroceder', callback_data: 'volver' }]] }
      });
      logAction('alerta', { userId, url, daysBefore: days });
    } else {
      await bot.sendMessage(chatId, `❌ No se pudo configurar: sin fecha de expiración.\n\n📢 *Grupos Entre Hijos*`, {
        message_thread_id: ALLOWED_THREAD_ID,
        reply_markup: { inline_keyboard: [[{ text: '⬅️ Retroceder', callback_data: 'volver' }]] }
      });
    }
  }

  // Exportar
  if (replyText.includes('📤 Escribe la URL')) {
    const url = msg.text;
    const result = await checkIPTVList(url);

    if (result.status === 'Activa' || result.status === 'active') {
      await bot.sendMessage(chatId, `📤 Lista exportada:\n${url}\nCompatible con VLC, IPTV Smarters, TiviMate.\n\n📢 *Grupos Entre Hijos*`, {
        message_thread_id: ALLOWED_THREAD_ID,
        reply_markup: { inline_keyboard: [[{ text: '⬅️ Retroceder', callback_data: 'volver' }]] }
      });
      logAction('exportar', { userId, url });
    } else {
      await bot.sendMessage(chatId, `❌ No se puede exportar: lista no activa.\n\n📢 *Grupos Entre Hijos*`, {
        message_thread_id: ALLOWED_THREAD_ID,
        reply_markup: { inline_keyboard: [[{ text: '⬅️ Retroceder', callback_data: 'volver' }]] }
      });
    }
  }

  // Filtrar Canales
  if (replyText.includes('📺 Escribe la URL')) {
    const [url, category] = msg.text.split(' ');
    const result = await checkIPTVList(url);

    if (result.type === 'Xtream Codes' && result.status === 'active') {
      const apiUrl = `${result.server}/player_api.php?username=${result.username}&password=${result.password}&action=get_live_streams`;
      const streams = (await axios.get(apiUrl)).data;
      const filtered = streams.filter(s => s.category_name.toLowerCase().includes(category.toLowerCase()));
      const filterMessage = `📺 "${category}":\n\n` +
        filtered.slice(0, 5).map(s => `📡 ${s.name}`).join('\n') +
        `\nTotal: ${filtered.length}\n\n📢 *Grupos Entre Hijos*`;
      await bot.sendMessage(chatId, filterMessage, {
        message_thread_id: ALLOWED_THREAD_ID,
        reply_markup: { inline_keyboard: [[{ text: '⬅️ Retroceder', callback_data: 'volver' }]] }
      });
    } else {
      await bot.sendMessage(chatId, `❌ No se puede filtrar: lista incompatible o inactiva.\n\n📢 *Grupos Entre Hijos*`, {
        message_thread_id: ALLOWED_THREAD_ID,
        reply_markup: { inline_keyboard: [[{ text: '⬅️ Retroceder', callback_data: 'volver' }]] }
      });
    }
  }
});

// Alertas diarias con node-cron (9:00 AM)
cron.schedule('0 9 * * *', async () => {
  for (const userId in alerts) {
    const { url, expiresAt, notifyDaysBefore } = alerts[userId];
    const daysLeft = Math.ceil((expiresAt - new Date()) / (1000 * 60 * 60 * 24));
    if (daysLeft <= notifyDaysBefore) {
      await bot.sendMessage(ALLOWED_CHAT_ID, `⏰ Alerta para <@${userId}>: ${url} expira en ${daysLeft} días (${expiresAt.toLocaleString('es-ES')}).\n\n📢 *Grupos Entre Hijos*`, {
        message_thread_id: ALLOWED_THREAD_ID,
        parse_mode: 'Markdown'
      });
      logAction('alerta_enviada', { userId, url, daysLeft });
    }
  }
});

console.log('🚀 EntreCheck_iptv iniciado correctamente 🎉');