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

app.use(express.json());

// Configuración del webhook
const webhookUrl = 'https://entrelinks.onrender.com';

// IDs permitidos
const ALLOWED_CHAT_ID = '-1002348662107';
const ALLOWED_THREAD_ID = '53411';

// Almacenar datos
let userHistory = {};
let alerts = {};
const logsFile = 'bot_logs.json';

// Inicializar logs
if (!fs.existsSync(logsFile)) {
  fs.writeFileSync(logsFile, JSON.stringify([]));
}

// Registrar acción en logs
function logAction(action, details) {
  const logs = JSON.parse(fs.readFileSync(logsFile));
  const timestamp = new Date().toLocaleString('es-ES');
  logs.push({ action, details, timestamp });
  fs.writeFileSync(logsFile, JSON.stringify(logs, null, 2));
}

// Ruta para el webhook
app.post(`/bot${token}`, (req, res) => {
  console.log('📩 Recibida actualización:', JSON.stringify(req.body));
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Ruta raíz
app.get('/', (req, res) => {
  res.send('EntreCheck_iptv is running');
});

// Iniciar servidor
app.listen(port, async () => {
  console.log(`🚀 Servidor en puerto ${port}`);
  await setWebhookWithRetry();
});

// Configurar webhook con reintentos
async function setWebhookWithRetry() {
  try {
    console.log(`Configurando webhook: ${webhookUrl}/bot${token}`);
    await bot.setWebHook(`${webhookUrl}/bot${token}`);
    console.log(`✅ Webhook configurado`);
  } catch (error) {
    if (error.response && error.response.status === 429) {
      const retryAfter = error.response.data.parameters.retry_after || 1;
      console.warn(`⚠️ Error 429. Reintentando en ${retryAfter}s...`);
      await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
      return setWebhookWithRetry();
    }
    console.error(`❌ Error webhook: ${error.message}`);
  }
}

// Verificar contexto permitido
function isAllowedContext(chatId, threadId) {
  return String(chatId) === ALLOWED_CHAT_ID && String(threadId) === ALLOWED_THREAD_ID;
}

// Función avanzada para verificar listas IPTV
async function checkIPTVList(url) {
  try {
    // Normalizar URL
    url = url.trim();
    if (!url.startsWith('http')) url = `http://${url}`;

    // Xtream Codes
    if (url.includes('get.php')) {
      const [, params] = url.split('?');
      const { username, password } = Object.fromEntries(new URLSearchParams(params));
      const server = url.split('/get.php')[0];
      const apiUrl = `${server}/player_api.php?username=${username}&password=${password}`;

      const response = await axios.get(apiUrl, { timeout: 3000 });
      const { user_info } = response.data;

      const streams = await axios.get(`${apiUrl}&action=get_live_streams`, { timeout: 3000 });
      const channels = streams.data.length;
      const quality = await analyzeStreamQuality(server, username, password);

      return {
        type: 'Xtream Codes',
        status: user_info.status === 'Active' ? 'Activa' : user_info.status,
        username: user_info.username,
        password: user_info.password,
        server,
        createdAt: new Date(user_info.created_at * 1000).toLocaleString('es-ES'),
        expiresAt: new Date(user_info.exp_date * 1000).toLocaleString('es-ES'),
        maxConnections: user_info.max_connections,
        activeConnections: user_info.active_cons,
        channels,
        quality: quality.resolution || '1080p (estimada)',
        bitrate: quality.bitrate || 'Desconocido',
        stability: quality.stability || 'Estable',
        risk: detectRisk(server)
      };
    }

    // M3U/M3U8
    if (url.endsWith('.m3u') || url.endsWith('.m3u8')) {
      const response = await axios.get(url, { timeout: 3000 });
      const lines = response.data.split('\n');
      const channels = lines.filter(line => line.startsWith('#EXTINF')).length;
      const quality = await analyzeM3UQuality(url);

      return {
        type: 'M3U/M3U8',
        status: channels > 0 ? 'Activa' : 'Inactiva',
        channels,
        quality: quality.resolution || '720p (estimada)',
        bitrate: quality.bitrate || 'Desconocido',
        stability: quality.stability || 'Estable',
        risk: detectRisk(url)
      };
    }

    // Enlace directo
    const response = await axios.head(url, { timeout: 3000 });
    const quality = await analyzeStreamQuality(url);
    return {
      type: 'Direct Link',
      status: response.status === 200 ? 'Activa' : 'Inactiva',
      quality: quality.resolution || 'SD (estimada)',
      bitrate: quality.bitrate || 'Desconocido',
      stability: quality.stability || 'Estable',
      risk: detectRisk(url)
    };
  } catch (error) {
    return {
      type: 'Desconocido',
      status: 'Error',
      error: error.message.includes('timeout') ? 'Tiempo de espera agotado' : error.message
    };
  }
}

// Análisis de calidad para streams
async function analyzeStreamQuality(server, username, password) {
  try {
    const url = username && password ? `${server}/live/${username}/${password}/1.ts` : server;
    const response = await axios.head(url, { timeout: 2000 });
    const size = response.headers['content-length'] || 0;
    const resolution = size > 2000000 ? '4K' : size > 1000000 ? '1080p' : size > 500000 ? '720p' : 'SD';
    return {
      resolution,
      bitrate: size > 0 ? `${Math.round(size / 1024)} kbps` : 'Desconocido',
      stability: response.status === 200 ? 'Estable' : 'Inestable'
    };
  } catch {
    return { resolution: 'Desconocida', bitrate: 'Desconocido', stability: 'No evaluada' };
  }
}

// Análisis de calidad para M3U
async function analyzeM3UQuality(url) {
  try {
    const response = await axios.get(url, { timeout: 2000 });
    const lines = response.data.split('\n');
    const channelLine = lines.find(line => line.startsWith('#EXTINF'));
    const resolution = channelLine.includes('1080') ? '1080p' : channelLine.includes('720') ? '720p' : 'SD';
    return {
      resolution,
      bitrate: 'Desconocido (M3U)',
      stability: 'Estable'
    };
  } catch {
    return { resolution: 'Desconocida', bitrate: 'Desconocido', stability: 'No evaluada' };
  }
}

// Detección de riesgos
function detectRisk(url) {
  const suspicious = ['suspicious', 'fake', 'malware', 'phishing'];
  return suspicious.some(term => url.toLowerCase().includes(term)) ? 'Riesgo detectado' : 'Sin riesgos aparentes';
}

// Barra de progreso
function generateProgressBar(progress, total) {
  const barLength = 20;
  const filled = Math.round((progress / total) * barLength);
  const empty = barLength - filled;
  return `📊 [${'█'.repeat(filled)}${'-'.repeat(empty)}] ${Math.round((progress / total) * 100)}%`;
}

// Menú principal
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

// Comando /iptv
bot.onText(/\/iptv/, async (msg) => {
  const chatId = msg.chat.id;
  const threadId = msg.message_thread_id || '0';
  if (!isAllowedContext(chatId, threadId)) {
    await bot.sendMessage(chatId, `🚫 Este bot solo funciona en: https://t.me/c/2348662107/53411\n\n📢 *Grupos Entre Hijos*`, {
      message_thread_id: threadId
    });
    return;
  }

  await bot.sendMessage(chatId, `👋 ¡Bienvenido a *EntreCheck_iptv*! 👋\n\nSelecciona una opción:\n\n📢 *Grupos Entre Hijos*`, {
    parse_mode: 'Markdown',
    reply_markup: mainMenu,
    message_thread_id: ALLOWED_THREAD_ID
  });
});

// Manejo de botones
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const threadId = query.message.message_thread_id || '0';
  const userId = query.from.id;

  if (!isAllowedContext(chatId, threadId)) {
    await bot.sendMessage(chatId, `🚫 Este bot solo funciona en: https://t.me/c/2348662107/53411\n\n📢 *Grupos Entre Hijos*`, {
      message_thread_id: threadId
    });
    return;
  }

  const action = query.data;
  const backButton = { inline_keyboard: [[{ text: '⬅️ Retroceder', callback_data: 'volver' }]] };

  if (action === 'verificar') {
    await bot.sendMessage(chatId, `🔍 Ingresa la URL de la lista IPTV:\nEjemplo: http://servidor.com/get.php?username=xxx&password=yyy\n\n📢 *Grupos Entre Hijos*`, {
      message_thread_id: ALLOWED_THREAD_ID,
      reply_markup: backButton
    });
  } else if (action === 'masivo') {
    await bot.sendMessage(chatId, `📦 Ingresa las URLs separadas por comas:\nEjemplo: url1, url2, url3\n\n📢 *Grupos Entre Hijos*`, {
      message_thread_id: ALLOWED_THREAD_ID,
      reply_markup: backButton
    });
  } else if (action === 'historial') {
    if (!userHistory[userId] || userHistory[userId].length === 0) {
      await bot.sendMessage(chatId, `ℹ️ No tienes historial.\n\n📢 *Grupos Entre Hijos*`, {
        message_thread_id: ALLOWED_THREAD_ID,
        reply_markup: backButton
      });
    } else {
      const history = userHistory[userId].slice(-5).map(h =>
        `📡 ${h.url}\nEstado: ${h.result.status}\nCalidad: ${h.result.quality}\n⏰ ${h.timestamp.toLocaleString('es-ES')}\n`
      ).join('\n');
      await bot.sendMessage(chatId, `📜 Historial (últimas 5):\n\n${history}\n📢 *Grupos Entre Hijos*`, {
        message_thread_id: ALLOWED_THREAD_ID,
        reply_markup: backButton
      });
    }
  } else if (action === 'alerta') {
    await bot.sendMessage(chatId, `⏰ Ingresa URL y días antes de avisar:\nEjemplo: http://servidor.com/get.php?username=xxx&password=yyy 3\n\n📢 *Grupos Entre Hijos*`, {
      message_thread_id: ALLOWED_THREAD_ID,
      reply_markup: backButton
    });
  } else if (action === 'exportar') {
    await bot.sendMessage(chatId, `📤 Ingresa la URL a exportar:\nEjemplo: http://servidor.com/get.php?username=xxx&password=yyy\n\n📢 *Grupos Entre Hijos*`, {
      message_thread_id: ALLOWED_THREAD_ID,
      reply_markup: backButton
    });
  } else if (action === 'filtrar') {
    await bot.sendMessage(chatId, `📺 Ingresa URL y categoría:\nEjemplo: http://servidor.com/get.php?username=xxx&password=yyy deportes\n\n📢 *Grupos Entre Hijos*`, {
      message_thread_id: ALLOWED_THREAD_ID,
      reply_markup: backButton
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

// Procesar respuestas
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const threadId = msg.message_thread_id || '0';
  const userId = msg.from.id;

  if (!isAllowedContext(chatId, threadId) || !msg.reply_to_message || msg.text.startsWith('/')) return;

  const replyText = msg.reply_to_message.text;
  const backButton = { inline_keyboard: [[{ text: '⬅️ Retroceder', callback_data: 'volver' }]] };

  // Verificar Lista
  if (replyText.includes('🔍 Ingresa la URL')) {
    const url = msg.text;
    const checking = await bot.sendMessage(chatId, `🔍 Verificando ${url}...\n${generateProgressBar(0, 1)}`, {
      message_thread_id: ALLOWED_THREAD_ID
    });
    const result = await checkIPTVList(url);

    if (!userHistory[userId]) userHistory[userId] = [];
    userHistory[userId].push({ url, result, timestamp: new Date() });

    const response = `✅ Resultado:\n\n` +
      `📡 Tipo: ${result.type}\n` +
      `Estado: ${result.status}\n` +
      (result.username ? `👤 Usuario: ${result.username}\n🔑 Contraseña: ${result.password}\n🌐 Servidor: ${result.server}\n` : '') +
      (result.createdAt ? `📅 Creada: ${result.createdAt}\n⏰ Expira: ${result.expiresAt}\n` : '') +
      (result.channels ? `📺 Canales: ${result.channels}\n` : '') +
      (result.maxConnections ? `🔗 Máx.: ${result.maxConnections}\n🔌 Activas: ${result.activeConnections}\n` : '') +
      `📽 Calidad: ${result.quality}\n` +
      `📈 Bitrate: ${result.bitrate || 'Desconocido'}\n` +
      `🛡️ Estabilidad: ${result.stability || 'No evaluada'}\n` +
      `⚠️ Riesgo: ${result.risk}\n` +
      (result.error ? `❌ Error: ${result.error}\n` : '') +
      `\n📢 *Grupos Entre Hijos*`;

    await bot.editMessageText(response, {
      chat_id: chatId,
      message_id: checking.message_id,
      parse_mode: 'Markdown',
      reply_markup: backButton
    });
    logAction('verificar', { userId, url, status: result.status });
  }

  // Verificar Múltiples
  if (replyText.includes('📦 Ingresa las URLs')) {
    const urls = msg.text.split(',').map(url => url.trim());
    const total = urls.length;
    const progress = await bot.sendMessage(chatId, `📦 Verificando ${total} listas...\n${generateProgressBar(0, total)}`, {
      message_thread_id: ALLOWED_THREAD_ID
    });

    let processed = 0;
    let results = [];

    for (const url of urls) {
      const result = await checkIPTVList(url);
      results.push({ url, status: result.status, quality: result.quality });
      processed++;
      await bot.editMessageText(
        `📦 Progreso: ${processed}/${total}\n${generateProgressBar(processed, total)}`,
        { chat_id: chatId, message_id: progress.message_id }
      );
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    if (!userHistory[userId]) userHistory[userId] = [];
    userHistory[userId].push(...results.map(r => ({ url: r.url, result: { status: r.status, quality: r.quality }, timestamp: new Date() })));

    const final = `✅ Resultados:\n\n` +
      results.map(r => `📡 ${r.url}: ${r.status} (${r.quality})`).join('\n') +
      `\n\n📢 *Grupos Entre Hijos*`;
    await bot.editMessageText(final, {
      chat_id: chatId,
      message_id: progress.message_id,
      parse_mode: 'Markdown',
      reply_markup: backButton
    });
    logAction('masivo', { userId, urls, processed });
  }

  // Alerta
  if (replyText.includes('⏰ Ingresa URL')) {
    const [url, daysBefore] = msg.text.split(' ');
    const days = parseInt(daysBefore);
    const result = await checkIPTVList(url);

    if (result.expiresAt) {
      alerts[userId] = { url, expiresAt: new Date(result.expiresAt), notifyDaysBefore: days };
      await bot.sendMessage(chatId, `⏰ Alerta configurada para ${url} (${days} días antes).\n\n📢 *Grupos Entre Hijos*`, {
        message_thread_id: ALLOWED_THREAD_ID,
        reply_markup: backButton
      });
      logAction('alerta', { userId, url, daysBefore: days });
    } else {
      await bot.sendMessage(chatId, `❌ Sin fecha de expiración.\n\n📢 *Grupos Entre Hijos*`, {
        message_thread_id: ALLOWED_THREAD_ID,
        reply_markup: backButton
      });
    }
  }

  // Exportar
  if (replyText.includes('📤 Ingresa la URL')) {
    const url = msg.text;
    const result = await checkIPTVList(url);

    if (result.status === 'Activa' || result.status === 'active') {
      const exportText = result.type === 'Xtream Codes' ?
        `${result.server}/get.php?username=${result.username}&password=${result.password}` : url;
      await bot.sendMessage(chatId, `📤 Exportada:\n${exportText}\nCompatible con VLC, IPTV Smarters, TiviMate.\n\n📢 *Grupos Entre Hijos*`, {
        message_thread_id: ALLOWED_THREAD_ID,
        reply_markup: backButton
      });
      logAction('exportar', { userId, url });
    } else {
      await bot.sendMessage(chatId, `❌ Lista no activa.\n\n📢 *Grupos Entre Hijos*`, {
        message_thread_id: ALLOWED_THREAD_ID,
        reply_markup: backButton
      });
    }
  }

  // Filtrar Canales
  if (replyText.includes('📺 Ingresa URL')) {
    const [url, category] = msg.text.split(' ');
    const result = await checkIPTVList(url);

    if (result.type === 'Xtream Codes' && result.status === 'active') {
      const apiUrl = `${result.server}/player_api.php?username=${result.username}&password=${result.password}&action=get_live_streams`;
      const streams = (await axios.get(apiUrl, { timeout: 3000 })).data;
      const filtered = streams.filter(s => s.category_name.toLowerCase().includes(category.toLowerCase()));
      const filterMessage = `📺 "${category}":\n\n` +
        filtered.slice(0, 5).map(s => `📡 ${s.name}`).join('\n') +
        `\nTotal: ${filtered.length}\n\n📢 *Grupos Entre Hijos*`;
      await bot.sendMessage(chatId, filterMessage, {
        message_thread_id: ALLOWED_THREAD_ID,
        reply_markup: backButton
      });
    } else {
      await bot.sendMessage(chatId, `❌ Lista incompatible o inactiva.\n\n📢 *Grupos Entre Hijos*`, {
        message_thread_id: ALLOWED_THREAD_ID,
        reply_markup: backButton
      });
    }
  }
});

// Alertas diarias (9:00 AM)
cron.schedule('0 9 * * *', async () => {
  for (const userId in alerts) {
    const { url, expiresAt, notifyDaysBefore } = alerts[userId];
    const daysLeft = Math.ceil((expiresAt - new Date()) / (1000 * 60 * 60 * 24));
    if (daysLeft <= notifyDaysBefore) {
      await bot.sendMessage(ALLOWED_CHAT_ID, `⏰ Alerta para <@${userId}>: ${url} expira en ${daysLeft} días (${expiresAt.toLocaleString('es-ES')}).\n\n📢 *Grupos Entre Hijos*`, {
        message_thread_id: ALLOWED_THREAD_ID,
        parse_mode: 'Markdown'
      });
      logAction('alerta_enviada', { useradiosId, url, daysLeft });
    }
  }
});

console.log('🚀 EntreCheck_iptv iniciado correctamente 🎉');