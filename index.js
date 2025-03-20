const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const cron = require('node-cron');
const fs = require('fs');
const axios = require('axios');

// Token del bot
const token = '7861676131:AAFLv4dBIFiHV1OYc8BJH2U8kWPal7lpBMQ';
const bot = new TelegramBot(token);

// Configuración de Express
const app = express();
const port = process.env.PORT || 10000;
app.use(express.json());

// Webhook
const webhookUrl = 'https://entrelinks.onrender.com';

// IDs permitidos
const ALLOWED_CHAT_ID = '-1002348662107';
const ALLOWED_THREAD_ID = '53411';

// Almacenar datos
let userHistory = {};
let alerts = {};
const logsFile = 'bot_logs.json';

// Inicializar logs
if (!fs.existsSync(logsFile)) fs.writeFileSync(logsFile, JSON.stringify([]));

// Registrar logs
function logAction(action, details) {
  const logs = JSON.parse(fs.readFileSync(logsFile));
  const timestamp = new Date().toLocaleString('es-ES');
  logs.push({ action, details, timestamp });
  fs.writeFileSync(logsFile, JSON.stringify(logs, null, 2));
  console.log(`[${timestamp}] ${action}:`, details);
}

// Ruta webhook
app.post(`/bot${token}`, (req, res) => {
  logAction('webhook_received', { update: req.body });
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.get('/', (req, res) => res.send('EntreCheck_iptv is running'));

// Iniciar servidor
app.listen(port, async () => {
  console.log(`🚀 Servidor en puerto ${port}`);
  await setWebhookWithRetry();
});

// Configurar webhook
async function setWebhookWithRetry() {
  try {
    await bot.setWebHook(`${webhookUrl}/bot${token}`);
    logAction('webhook_set', { url: `${webhookUrl}/bot${token}` });
  } catch (error) {
    logAction('webhook_error', { error: error.message, status: error.response?.status });
    if (error.response?.status === 429) {
      const retryAfter = error.response.data.parameters.retry_after || 1;
      console.warn(`⚠️ Error 429. Reintentando en ${retryAfter}s...`);
      await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
      return setWebhookWithRetry();
    }
  }
}

// Verificar contexto
function isAllowedContext(chatId, threadId) {
  return String(chatId) === ALLOWED_CHAT_ID && String(threadId) === ALLOWED_THREAD_ID;
}

// Verificar lista IPTV
async function checkIPTVList(url) {
  logAction('check_start', { url });
  try {
    url = url.trim();
    if (!url.startsWith('http')) url = `http://${url}`;

    // Xtream Codes
    if (url.includes('get.php')) {
      logAction('check_xtream', { url });
      const [, params] = url.split('?');
      const { username, password } = Object.fromEntries(new URLSearchParams(params));
      const server = url.split('/get.php')[0];
      const apiUrl = `${server}/player_api.php?username=${username}&password=${password}`;

      const response = await axios.get(apiUrl, { timeout: 2000 });
      const { user_info } = response.data;
      const streams = await axios.get(`${apiUrl}&action=get_live_streams`, { timeout: 2000 });
      const quality = await analyzeStreamQuality(server, username, password);

      logAction('check_xtream_success', { url, channels: streams.data.length });
      return {
        type: 'Xtream Codes',
        status: user_info.status === 'Active' ? 'Activa' : user_info.status,
        username,
        password,
        server,
        createdAt: new Date(user_info.created_at * 1000).toLocaleString('es-ES'),
        expiresAt: new Date(user_info.exp_date * 1000).toLocaleString('es-ES'),
        maxConnections: user_info.max_connections,
        activeConnections: user_info.active_cons,
        channels: streams.data.length,
        categories: [...new Set(streams.data.map(s => s.category_name))].join(', '),
        quality: quality.resolution,
        bitrate: quality.bitrate,
        stability: quality.stability,
        risk: detectRisk(server)
      };
    }

    // M3U/M3U8
    if (url.endsWith('.m3u') || url.endsWith('.m3u8')) {
      logAction('check_m3u', { url });
      const response = await axios.get(url, { timeout: 2000 });
      const lines = response.data.split('\n');
      const channels = lines.filter(line => line.startsWith('#EXTINF')).length;
      const quality = await analyzeM3UQuality(url);

      logAction('check_m3u_success', { url, channels });
      return {
        type: 'M3U/M3U8',
        status: channels > 0 ? 'Activa' : 'Inactiva',
        channels,
        quality: quality.resolution,
        bitrate: quality.bitrate,
        stability: quality.stability,
        risk: detectRisk(url)
      };
    }

    // Enlace directo
    logAction('check_direct', { url });
    const response = await axios.head(url, { timeout: 2000 });
    const quality = await analyzeStreamQuality(url);

    logAction('check_direct_success', { url });
    return {
      type: 'Direct Link',
      status: response.status === 200 ? 'Activa' : 'Inactiva',
      quality: quality.resolution,
      bitrate: quality.bitrate,
      stability: quality.stability,
      risk: detectRisk(url)
    };
  } catch (error) {
    const errorMsg = error.message.includes('timeout') ? 'Tiempo agotado' : error.message;
    logAction('check_error', { url, error: errorMsg });
    return { type: 'Desconocido', status: 'Error', error: errorMsg };
  }
}

// Análisis de calidad
async function analyzeStreamQuality(url, username, password) {
  try {
    const testUrl = username && password ? `${url}/live/${username}/${password}/1.ts` : url;
    const response = await axios.head(testUrl, { timeout: 1500 });
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

async function analyzeM3UQuality(url) {
  try {
    const response = await axios.get(url, { timeout: 1500 });
    const lines = response.data.split('\n');
    const channelLine = lines.find(line => line.startsWith('#EXTINF'));
    const resolution = channelLine?.includes('1080') ? '1080p' : channelLine?.includes('720') ? '720p' : 'SD';
    return { resolution, bitrate: 'Desconocido', stability: 'Estable' };
  } catch {
    return { resolution: 'Desconocida', bitrate: 'Desconocido', stability: 'No evaluada' };
  }
}

// Detección de riesgos
function detectRisk(url) {
  const suspicious = ['suspicious', 'fake', 'malware', 'phishing'];
  return suspicious.some(term => url.toLowerCase().includes(term)) ? 'Riesgo detectado' : 'Sin riesgos';
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
    [{ text: '🔍 Verificar Lista', callback_data: 'verificar' }, { text: '📦 Verificar Múltiples', callback_data: 'masivo' }],
    [{ text: '📜 Historial', callback_data: 'historial' }, { text: '⏰ Alerta', callback_data: 'alerta' }],
    [{ text: '📤 Exportar', callback_data: 'exportar' }, { text: '📺 Filtrar Canales', callback_data: 'filtrar' }]
  ]
};

// Comando /iptv
bot.onText(/\/iptv/, async (msg) => {
  const chatId = msg.chat.id;
  const threadId = msg.message_thread_id || '0';
  if (!isAllowedContext(chatId, threadId)) {
    await bot.sendMessage(chatId, `🚫 Solo funciona en: https://t.me/c/2348662107/53411\n\n📢 *Grupos Entre Hijos*`, { message_thread_id: threadId });
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
    await bot.sendMessage(chatId, `🚫 Solo funciona en: https://t.me/c/2348662107/53411\n\n📢 *Grupos Entre Hijos*`, { message_thread_id: threadId });
    return;
  }

  const action = query.data;
  const backButton = { inline_keyboard: [[{ text: '⬅️ Retroceder', callback_data: 'volver' }]] };

  try {
    if (action === 'verificar') {
      await bot.sendMessage(chatId, `🔍 Ingresa la URL:\nEjemplo: http://servidor.com/get.php?username=xxx&password=yyy\n\n📢 *Grupos Entre Hijos*`, {
        message_thread_id: ALLOWED_THREAD_ID,
        reply_markup: backButton
      });
    } else if (action === 'masivo') {
      await bot.sendMessage(chatId, `📦 Ingresa URLs (separadas por comas):\nEjemplo: url1, url2\n\n📢 *Grupos Entre Hijos*`, {
        message_thread_id: ALLOWED_THREAD_ID,
        reply_markup: backButton
      });
    } else if (action === 'historial') {
      if (!userHistory[userId] || userHistory[userId].length === 0) {
        await bot.sendMessage(chatId, `ℹ️ Sin historial.\n\n📢 *Grupos Entre Hijos*`, { message_thread_id: ALLOWED_THREAD_ID, reply_markup: backButton });
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
      await bot.sendMessage(chatId, `⏰ Ingresa URL y días:\nEjemplo: http://servidor.com/get.php?username=xxx&password=yyy 3\n\n📢 *Grupos Entre Hijos*`, {
        message_thread_id: ALLOWED_THREAD_ID,
        reply_markup: backButton
      });
    } else if (action === 'exportar') {
      await bot.sendMessage(chatId, `📤 Ingresa URL a exportar:\nEjemplo: http://servidor.com/get.php?username=xxx&password=yyy\n\n📢 *Grupos Entre Hijos*`, {
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
  } catch (error) {
    logAction('callback_error', { action, error: error.message, userId });
    await bot.sendMessage(chatId, `❌ Error procesando tu solicitud. Intenta de nuevo.\n\n📢 *Grupos Entre Hijos*`, {
      message_thread_id: ALLOWED_THREAD_ID
    });
  }

  await bot.answerCallbackQuery(query.id);
});

// Procesar respuestas
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const threadId = msg.message_thread_id || '0';
  const userId = msg.from.id;

  if (!isAllowedContext(chatId, threadId) || msg.text.startsWith('/')) return;

  const replyToMessage = msg.reply_to_message;
  const backButton = { inline_keyboard: [[{ text: '⬅️ Retroceder', callback_data: 'volver' }]] };

  try {
    // Verificar si es una respuesta a un mensaje del bot
    if (!replyToMessage || !replyToMessage.from || !replyToMessage.from.is_bot) {
      logAction('no_reply', { userId, text: msg.text });
      return;
    }

    const replyText = replyToMessage.text || '';
    logAction('processing_message', { userId, text: msg.text, replyText });

    if (replyText.includes('🔍 Ingresa la URL')) {
      const url = msg.text;
      const checking = await bot.sendMessage(chatId, `🔍 Verificando ${url}...\n${generateProgressBar(0, 1)}`, { message_thread_id: ALLOWED_THREAD_ID });
      const result = await checkIPTVList(url);

      if (!userHistory[userId]) userHistory[userId] = [];
      userHistory[userId].push({ url, result, timestamp: new Date() });

      const response = `✅ Resultado:\n\n` +
        `📡 Tipo: ${result.type}\n` +
        `Estado: ${result.status}\n` +
        (result.username ? `👤 Usuario: ${result.username}\n🔑 Contraseña: ${result.password}\n🌐 Servidor: ${result.server}\n` : '') +
        (result.createdAt ? `📅 Creada: ${result.createdAt}\n⏰ Expira: ${result.expiresAt}\n` : '') +
        (result.channels ? `📺 Canales: ${result.channels}\n` : '') +
        (result.categories ? `📋 Categorías: ${result.categories}\n` : '') +
        (result.maxConnections ? `🔗 Máx.: ${result.maxConnections}\n🔌 Activas: ${result.activeConnections}\n` : '') +
        `📽 Calidad: ${result.quality}\n` +
        `📈 Bitrate: ${result.bitrate}\n` +
        `🛡️ Estabilidad: ${result.stability}\n` +
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

    if (replyText.includes('📦 Ingresa URLs')) {
      const urls = msg.text.split(',').map(url => url.trim());
      const total = urls.length;
      const progress = await bot.sendMessage(chatId, `📦 Verificando ${total} listas...\n${generateProgressBar(0, total)}`, { message_thread_id: ALLOWED_THREAD_ID });

      let processed = 0;
      let results = [];

      for (const url of urls) {
        const result = await checkIPTVList(url);
        results.push({ url, status: result.status, quality: result.quality });
        processed++;
        await bot.editMessageText(`📦 Progreso: ${processed}/${total}\n${generateProgressBar(processed, total)}`, {
          chat_id: chatId,
          message_id: progress.message_id
        });
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

    if (replyText.includes('⏰ Ingresa URL')) {
      const [url, daysBefore] = msg.text.split(' ');
      const days = parseInt(daysBefore);
      const result = await checkIPTVList(url);

      if (result.expiresAt) {
        alerts[userId] = { url, expiresAt: new Date(result.expiresAt), notifyDaysBefore: days };
        await bot.sendMessage(chatId, `⏰ Alerta configurada: ${url} (${days} días).\n\n📢 *Grupos Entre Hijos*`, {
          message_thread_id: ALLOWED_THREAD_ID,
          reply_markup: backButton
        });
        logAction('alerta', { userId, url, daysBefore: days });
      } else {
        await bot.sendMessage(chatId, `❌ Sin fecha de expiración.\n\n📢 *Grupos Entre Hijos*`, { message_thread_id: ALLOWED_THREAD_ID, reply_markup: backButton });
      }
    }

    if (replyText.includes('📤 Ingresa URL')) {
      const url = msg.text;
      const result = await checkIPTVList(url);

      if (result.status === 'Activa' || result.status === 'active') {
        const exportText = result.type === 'Xtream Codes' ? `${result.server}/get.php?username=${result.username}&password=${result.password}` : url;
        await bot.sendMessage(chatId, `📤 Exportada:\n${exportText}\nCompatible con VLC, IPTV Smarters, TiviMate.\n\n📢 *Grupos Entre Hijos*`, {
          message_thread_id: ALLOWED_THREAD_ID,
          reply_markup: backButton
        });
        logAction('exportar', { userId, url });
      } else {
        await bot.sendMessage(chatId, `❌ Lista no activa.\n\n📢 *Grupos Entre Hijos*`, { message_thread_id: ALLOWED_THREAD_ID, reply_markup: backButton });
      }
    }

    if (replyText.includes('📺 Ingresa URL')) {
      const [url, category] = msg.text.split(' ');
      const result = await checkIPTVList(url);

      if (result.type === 'Xtream Codes' && result.status === 'active') {
        const apiUrl = `${result.server}/player_api.php?username=${result.username}&password=${result.password}&action=get_live_streams`;
        const streams = (await axios.get(apiUrl, { timeout: 2000 })).data;
        const filtered = streams.filter(s => s.category_name.toLowerCase().includes(category.toLowerCase()));
        const filterMessage = `📺 "${category}":\n\n` +
          filtered.slice(0, 5).map(s => `📡 ${s.name}`).join('\n') +
          `\nTotal: ${filtered.length}\n\n📢 *Grupos Entre Hijos*`;
        await bot.sendMessage(chatId, filterMessage, { message_thread_id: ALLOWED_THREAD_ID, reply_markup: backButton });
      } else {
        await bot.sendMessage(chatId, `❌ Lista incompatible o inactiva.\n\n📢 *Grupos Entre Hijos*`, { message_thread_id: ALLOWED_THREAD_ID, reply_markup: backButton });
      }
    }
  } catch (error) {
    logAction('message_error', { userId, text: msg.text, error: error.message });
    await bot.sendMessage(chatId, `❌ Error: ${error.message}\nIntenta de nuevo.\n\n📢 *Grupos Entre Hijos*`, {
      message_thread_id: ALLOWED_THREAD_ID
    });
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
      logAction('alerta_enviada', { userId, url, daysLeft });
    }
  }
});

console.log('🚀 EntreCheck_iptv iniciado 🎉');