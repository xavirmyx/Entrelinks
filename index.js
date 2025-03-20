const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const cron = require('node-cron');
const fs = require('fs');
const axios = require('axios');

// Token del bot
const token = '7861676131:AAFLv4dBIFiHV1OYc8BJH2U8kWPal7lpBMQ';
const bot = new TelegramBot(token);
const botName = 'EntreCheck_iptv'; // Nombre del bot

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
      logAction('check_xtream', { url });
      const [, params] = url.split('?');
      const { username, password } = Object.fromEntries(new URLSearchParams(params));
      const server = url.split('/get.php')[0];
      const apiUrl = `${server}/player_api.php?username=${username}&password=${password}`;

      const response = await axios.get(apiUrl, { timeout: 2000 });
      const { user_info } = response.data;
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
        channels: streams.data.map(s => s.name).join(' 🤖 '),
        movies: vod.data.map(v => v.name).join(' 🤖 '),
        series: series.data.map(s => s.name).join(' 🤖 '),
        timezone: response.data.server_info.timezone || 'Desconocida'
      };
    }

    if (url.endsWith('.m3u') || url.endsWith('.m3u8')) {
      logAction('check_m3u', { url });
      const response = await axios.get(url, { timeout: 2000 });
      const lines = response.data.split('\n');
      const channels = lines.filter(line => line.startsWith('#EXTINF')).map(line => line.split(',')[1].trim()).join(' 🤖 ');

      logAction('check_m3u_success', { url, channels: channels.length });
      return {
        type: 'M3U/M3U8',
        status: channels.length > 0 ? 'Activa' : 'Inactiva',
        channels,
        movies: '',
        series: ''
      };
    }

    logAction('check_error', { url, error: 'Formato no soportado' });
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

  let response = `🌟 Hola ${username}, aquí está la información de tu lista gracias a *${botName}* 🌟\n\n` +
    `📅 *Día y hora de comprobación*: ${timestamp}\n\n` +
    `🍁 *Lista M3U*: ${result.type === 'Xtream Codes' ? `${result.server}/get.php?username=${result.username}&password=${result.password}&type=m3u_plus` : result.server || 'N/A'}\n` +
    `⚙️ *Player API*: ${result.type === 'Xtream Codes' ? `${result.server}/player_api.php?username=${result.username}&password=${result.password}` : 'N/A'}\n\n` +
    `🧾 *Mensaje*: Welcome to ${botName.toUpperCase()} - Copyright 2020-2025 All Rights Reserved\n` +
    `${result.status === 'Active' ? '🟢' : '🔴'} *Estado*: ${result.status}\n` +
    `${result.username ? `👤 *Combo*: ${result.username}:${result.password}\n` : ''}` +
    `📅 *Fecha de Creación*: ${result.createdAt}\n` +
    `📅 *Fecha de Caducidad*: ${result.expiresAt}\n` +
    `${result.activeConnections !== undefined ? `👥 *Conexiones activas*: ${result.activeConnections}\n` : ''}` +
    `${result.maxConnections !== undefined ? `👥 *Conexiones máximas*: ${result.maxConnections}\n` : ''}` +
    `🔢 *Total de Contenido*: ${result.channels.split(' 🤖 ').length || 0}\n` +
    `${result.server ? `🖥 *Servidor Real*: ${result.server}\n` : ''}` +
    `🌍 *TimeZone*: ${result.timezone || 'N/A'}\n\n` +
    `📺 *Listado de Canales*: ${result.channels || 'No disponible'}\n\n` +
    `🎥 *Listado de Películas*: ${result.movies || 'No disponible'}\n\n` +
    `📼 *Listado de Series*: ${result.series || 'No disponible'}\n\n` +
    `🤖 *By ${botName}*`;

  return response;
}

// Comando /iptv
bot.onText(/\/iptv/, async (msg) => {
  const chatId = msg.chat.id;
  const threadId = msg.message_thread_id || '0';
  if (!isAllowedContext(chatId, threadId)) {
    await bot.sendMessage(chatId, `🚫 Solo funciona en: https://t.me/c/2348662107/53411\n\n📢 *Grupos Entre Hijos*`, { message_thread_id: threadId });
    return;
  }

  await bot.sendMessage(chatId, `👋 ¡Bienvenido a *${botName}*! 👋\n\nSelecciona una opción:\n\n📢 *Grupos Entre Hijos*`, {
    parse_mode: 'Markdown',
    message_thread_id: ALLOWED_THREAD_ID
  });
});

// Procesar mensajes con URLs IPTV
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const threadId = msg.message_thread_id || '0';
  const userId = msg.from.id;
  const text = msg.text || '';

  if (!isAllowedContext(chatId, threadId) || text.startsWith('/')) return;

  const isIPTVUrl = text.match(/http[s]?:\/\/[^\s]+(get\.php|\.m3u|\.m3u8)/i);
  if (isIPTVUrl) {
    const url = text;
    const checking = await bot.sendMessage(chatId, `🔍 Verificando ${url}...`, { message_thread_id: ALLOWED_THREAD_ID });
    const result = await checkIPTVList(url);

    if (!userHistory[userId]) userHistory[userId] = [];
    userHistory[userId].push({ url, result, timestamp: new Date() });

    const response = formatResponse(msg, result);
    await bot.editMessageText(response, {
      chat_id: chatId,
      message_id: checking.message_id,
      parse_mode: 'Markdown'
    });
    logAction('verificar', { userId, url, status: result.status });
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

console.log(`🚀 ${botName} iniciado 🎉`);