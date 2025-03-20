const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const cron = require('node-cron');
const fs = require('fs');
const axios = require('axios');

// Token del bot y nombre
const token = '7861676131:AAFLv4dBIFiHV1OYc8BJH2U8kWPal7lpBMQ';
const bot = new TelegramBot(token);
const botName = 'EntreCheck_iptv';

// Configuración de Express
const app = express();
const port = process.env.PORT || 10000;
app.use(express.json());

// Webhook (sin modificar)
const webhookUrl = 'https://entrelinks.onrender.com';

// IDs permitidos
const ALLOWED_CHAT_ID = '-1002348662107';
const ALLOWED_THREAD_ID = '53411';

// Almacenar datos
let userHistory = {};
let alerts = {};
const logsFile = 'bot_logs.json';

// Mensaje fijo
const adminMessage = '\n\n👨‍💼 *Equipo de Administración EntresHijos*';

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

// Escapar caracteres especiales para Markdown
function escapeMarkdown(text) {
  return text.replace(/([_*[\]()~`>#+\-=|{}.!])/g, '\\$1');
}

// Ruta webhook
app.post(`/bot${token}`, (req, res) => {
  logAction('webhook_received', { update: req.body });
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.get('/', (req, res) => res.send(`${botName} is running`));

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

    if (url.includes('get.php')) {
      const [, params] = url.split('?');
      const { username, password } = Object.fromEntries(new URLSearchParams(params));
      const server = url.split('/get.php')[0];
      const apiUrl = `${server}/player_api.php?username=${username}&password=${password}`;

      const response = await axios.get(apiUrl, { timeout: 2000 });
      const { user_info, server_info } = response.data;
      const streams = await axios.get(`${apiUrl}&action=get_live_streams`, { timeout: 2000 });
      const vod = await axios.get(`${apiUrl}&action=get_vod_streams`, { timeout: 2000 });
      const series = await axios.get(`${apiUrl}&action=get_series`, { timeout: 2000 });

      logAction('check_xtream_success', { url, channels: streams.data.length });
      return {
        type: 'Xtream Codes',
        status: user_info.status,
        username,
        password,
        server,
        createdAt: user_info.created_at ? new Date(user_info.created_at * 1000).toLocaleDateString('es-ES') : 'Desconocida',
        expiresAt: user_info.exp_date ? new Date(user_info.exp_date * 1000).toLocaleDateString('es-ES') : 'Ilimitada',
        activeConnections: user_info.active_cons,
        maxConnections: user_info.max_connections,
        channels: streams.data.slice(0, 10).map(s => s.name), // Limitar a 10 canales
        movies: vod.data.slice(0, 5).map(v => v.name),       // Limitar a 5 películas
        series: series.data.slice(0, 5).map(s => s.name),   // Limitar a 5 series
        totalChannels: streams.data.length,
        totalMovies: vod.data.length,
        totalSeries: series.data.length,
        timezone: server_info.timezone || 'Desconocida'
      };
    }

    if (url.endsWith('.m3u') || url.endsWith('.m3u8')) {
      const response = await axios.get(url, { timeout: 2000 });
      const lines = response.data.split('\n');
      const channels = lines.filter(line => line.startsWith('#EXTINF')).map(line => line.split(',')[1].trim()).slice(0, 10); // Limitar a 10

      logAction('check_m3u_success', { url, channels: channels.length });
      return {
        type: 'M3U/M3U8',
        status: channels.length > 0 ? 'Activa' : 'Inactiva',
        channels,
        movies: [],
        series: [],
        totalChannels: lines.filter(line => line.startsWith('#EXTINF')).length,
        totalMovies: 0,
        totalSeries: 0
      };
    }

    return { type: 'Desconocido', status: 'Error', error: 'Formato no soportado' };
  } catch (error) {
    const errorMsg = error.message.includes('timeout') ? 'Tiempo agotado' : error.message;
    logAction('check_error', { url, error: errorMsg });
    return { type: 'Desconocido', status: 'Error', error: errorMsg };
  }
}

// Formatear respuesta profesional
function formatResponse(msg, result) {
  const timestamp = new Date().toLocaleString('es-ES', { timeZone: 'America/Mexico_City' });
  const username = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;

  let response = `✨ Hola ${escapeMarkdown(username)}, aquí tienes los detalles de tu lista IPTV gracias a *${botName}* ✨\n\n` +
    `⏳ *Verificado el*: ${timestamp}\n\n` +
    `📡 *Lista M3U*: ${escapeMarkdown(result.type === 'Xtream Codes' ? `${result.server}/get.php?username=${result.username}&password=${result.password}&type=m3u_plus` : result.server || 'N/A')}\n` +
    `🔧 *Player API*: ${escapeMarkdown(result.type === 'Xtream Codes' ? `${result.server}/player_api.php?username=${result.username}&password=${result.password}` : 'N/A')}\n\n` +
    `📜 *Mensaje*: Bienvenido a ${botName.toUpperCase()} - Servicio gratuito 2020-2025\n` +
    `${result.status === 'Active' ? '✅' : '❌'} *Estado*: ${result.status === 'Active' ? 'Activa' : result.status}\n` +
    `${result.username ? `👤 *Credenciales*: ${escapeMarkdown(result.username)}:${escapeMarkdown(result.password)}\n` : ''}` +
    `📅 *Creada*: ${result.createdAt}\n` +
    `⏰ *Expira*: ${result.expiresAt}\n` +
    `${result.activeConnections !== undefined ? `🔗 *Conexiones activas*: ${result.activeConnections}\n` : ''}` +
    `${result.maxConnections !== undefined ? `🔗 *Conexiones máximas*: ${result.maxConnections}\n` : ''}` +
    `📊 *Total de canales*: ${result.totalChannels || 0}\n` +
    `🎬 *Total de películas*: ${result.totalMovies || 0}\n` +
    `📽 *Total de series*: ${result.totalSeries || 0}\n` +
    `${result.server ? `🌍 *Servidor*: ${escapeMarkdown(result.server)}\n` : ''}` +
    `⏲ *Zona horaria*: ${result.timezone || 'N/A'}\n\n` +
    `📺 *Canales (muestra)*: ${result.channels.length > 0 ? result.channels.map(c => escapeMarkdown(c)).join(' 🌐 ') : 'No disponible'}\n` +
    `${result.channels.length < result.totalChannels ? `*(+${result.totalChannels - result.channels.length} más)*` : ''}\n\n` +
    `🎬 *Películas (muestra)*: ${result.movies.length > 0 ? result.movies.map(m => escapeMarkdown(m)).join(' 🌐 ') : 'No disponible'}\n` +
    `${result.movies.length < result.totalMovies ? `*(+${result.totalMovies - result.movies.length} más)*` : ''}\n\n` +
    `📽 *Series (muestra)*: ${result.series.length > 0 ? result.series.map(s => escapeMarkdown(s)).join(' 🌐 ') : 'No disponible'}\n` +
    `${result.series.length < result.totalSeries ? `*(+${result.totalSeries - result.series.length} más)*` : ''}\n\n` +
    `🚀 *Potenciado por ${botName} - 100% Gratis*${adminMessage}`;

  return response;
}

// Menú principal con botones
const mainMenu = {
  reply_markup: {
    inline_keyboard: [
      [{ text: '🔎 Verificar Lista', callback_data: 'check' }, { text: '📑 Historial', callback_data: 'history' }],
      [{ text: '⏱ Configurar Alerta', callback_data: 'alert' }, { text: 'ℹ️ Ayuda', callback_data: 'help' }]
    ]
  }
};

// Comando /iptv
bot.onText(/\/iptv/, async (msg) => {
  const chatId = msg.chat.id;
  const threadId = msg.message_thread_id || '0';
  if (!isAllowedContext(chatId, threadId)) {
    await bot.sendMessage(chatId, `🚫 Este bot solo funciona en: https://t.me/c/2348662107/53411${adminMessage}`, { message_thread_id: threadId, parse_mode: 'Markdown' });
    return;
  }

  await bot.sendMessage(chatId, `🌟 ¡Bienvenido a *${botName}*! 🌟\n\nSoy un bot gratuito para verificar listas IPTV. Usa los botones o envía un enlace directamente.\n\n*Comandos disponibles*:\n/iptv - Iniciar\n/guia - Ayuda${adminMessage}`, {
    parse_mode: 'Markdown',
    message_thread_id: ALLOWED_THREAD_ID,
    ...mainMenu
  });
});

// Comando /guia
bot.onText(/\/guia/, async (msg) => {
  const chatId = msg.chat.id;
  const threadId = msg.message_thread_id || '0';
  if (!isAllowedContext(chatId, threadId)) return;

  await bot.sendMessage(chatId, `ℹ️ *Ayuda de ${botName}* ℹ️\n\n- Envía un enlace IPTV (M3U o Xtream) y lo verificaré.\n- Usa /iptv para el menú.\n- Totalmente gratis y sin límites.\n\n*Ejemplo*:\nhttp://server.com/get.php?username=xxx&password=yyy${adminMessage}`, {
    parse_mode: 'Markdown',
    message_thread_id: ALLOWED_THREAD_ID,
    ...mainMenu
  });
});

// Manejo de botones
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const threadId = query.message.message_thread_id || '0';
  const userId = query.from.id;

  if (!isAllowedContext(chatId, threadId)) return;

  const action = query.data;
  try {
    if (action === 'check') {
      await bot.sendMessage(chatId, `🔎 Envía un enlace IPTV para verificar (M3U o Xtream):${adminMessage}`, { message_thread_id: ALLOWED_THREAD_ID, parse_mode: 'Markdown' });
    } else if (action === 'history') {
      if (!userHistory[userId] || userHistory[userId].length === 0) {
        await bot.sendMessage(chatId, `📑 Tu historial está vacío. Verifica una lista primero.${adminMessage}`, { message_thread_id: ALLOWED_THREAD_ID, parse_mode: 'Markdown', ...mainMenu });
      } else {
        const history = userHistory[userId].slice(-5).map(h => `📡 ${escapeMarkdown(h.url)}\n${h.result.status === 'Active' ? '✅' : '❌'} ${h.result.status}\n⏳ ${h.timestamp.toLocaleString('es-ES')}`).join('\n\n');
        await bot.sendMessage(chatId, `📑 *Últimas 5 verificaciones*:\n\n${history}${adminMessage}`, { parse_mode: 'Markdown', message_thread_id: ALLOWED_THREAD_ID, ...mainMenu });
      }
    } else if (action === 'alert') {
      await bot.sendMessage(chatId, `⏱ Envía un enlace IPTV seguido de los días para la alerta:\nEjemplo: http://server.com/get.php?username=xxx&password=yyy 3${adminMessage}`, { message_thread_id: ALLOWED_THREAD_ID, parse_mode: 'Markdown' });
    } else if (action === 'help') {
      await bot.sendMessage(chatId, `ℹ️ *Ayuda de ${botName}* ℹ️\n\n- Envía un enlace IPTV para verificarlo.\n- Usa /iptv para el menú.\n- Gratis y sin límites.${adminMessage}`, { parse_mode: 'Markdown', message_thread_id: ALLOWED_THREAD_ID, ...mainMenu });
    }
    await bot.answerCallbackQuery(query.id);
  } catch (error) {
    logAction('callback_error', { action, error: error.message });
    await bot.sendMessage(chatId, `❌ Error: ${error.message}${adminMessage}`, { message_thread_id: ALLOWED_THREAD_ID, parse_mode: 'Markdown' });
  }
});

// Procesar mensajes con URLs IPTV o alertas
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const threadId = msg.message_thread_id || '0';
  const userId = msg.from.id;
  const text = msg.text || '';

  if (!isAllowedContext(chatId, threadId) || text.startsWith('/')) return;

  const isIPTVUrl = text.match(/http[s]?:\/\/[^\s]+(get\.php|\.m3u|\.m3u8)/i);
  const replyTo = msg.reply_to_message?.text || '';

  try {
    if (isIPTVUrl) {
      const url = text.split(' ')[0];
      const days = text.split(' ')[1] || null;
      const checking = await bot.sendMessage(chatId, `🔎 Verificando ${escapeMarkdown(url)}...${adminMessage}`, { message_thread_id: ALLOWED_THREAD_ID, parse_mode: 'Markdown' });
      const result = await checkIPTVList(url);

      if (!userHistory[userId]) userHistory[userId] = [];
      userHistory[userId].push({ url, result, timestamp: new Date() });

      const response = formatResponse(msg, result);
      await bot.editMessageText(response, {
        chat_id: chatId,
        message_id: checking.message_id,
        parse_mode: 'Markdown'
      });
      await bot.sendMessage(chatId, result.status === 'Active' ? '✅' : '❌', { message_thread_id: ALLOWED_THREAD_ID });

      if (days && replyTo.includes('⏱')) {
        if (result.expiresAt !== 'Ilimitada') {
          alerts[userId] = { url, expiresAt: new Date(result.expiresAt), notifyDaysBefore: parseInt(days) };
          await bot.sendMessage(chatId, `⏱ Alerta configurada para ${escapeMarkdown(url)} (${days} días antes).${adminMessage}`, { message_thread_id: ALLOWED_THREAD_ID, parse_mode: 'Markdown' });
        } else {
          await bot.sendMessage(chatId, `❌ No se puede configurar alerta: Lista ilimitada.${adminMessage}`, { message_thread_id: ALLOWED_THREAD_ID, parse_mode: 'Markdown' });
        }
      }
    }
  } catch (error) {
    logAction('message_error', { userId, text, error: error.message });
    await bot.sendMessage(chatId, `❌ Error: ${error.message}${adminMessage}`, { message_thread_id: ALLOWED_THREAD_ID, parse_mode: 'Markdown' });
  }
});

// Alertas diarias (9:00 AM)
cron.schedule('0 9 * * *', async () => {
  for (const userId in alerts) {
    const { url, expiresAt, notifyDaysBefore } = alerts[userId];
    const daysLeft = Math.ceil((expiresAt - new Date()) / (1000 * 60 * 60 * 24));
    if (daysLeft <= notifyDaysBefore) {
      await bot.sendMessage(ALLOWED_CHAT_ID, `⏱ *Alerta* para <@${userId}>:\n${escapeMarkdown(url)} expira en ${daysLeft} días (${expiresAt.toLocaleString('es-ES')}).${adminMessage}`, {
        message_thread_id: ALLOWED_THREAD_ID,
        parse_mode: 'Markdown'
      });
      await bot.sendMessage(ALLOWED_CHAT_ID, `⚠️`, { message_thread_id: ALLOWED_THREAD_ID });
      logAction('alerta_enviada', { userId, url, daysLeft });
    }
  }
});

console.log(`🚀 ${botName} iniciado 🎉`);