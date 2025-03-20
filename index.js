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

// IDs permitidos y estado de grupos
const ALLOWED_CHAT_IDS = [
  { chatId: '-1002348662107', threadId: '53411', name: 'EntresHijos', active: true },
  { chatId: '-1002565012502', threadId: null, name: 'BotChecker_IPTV_ParaG', active: true }
];

// Almacenar datos
let userHistory = {};
let alerts = {};
let stats = { totalChecks: 0, uniqueUsers: new Set(), activeAlerts: 0 };
const logsFile = 'bot_logs.json';
const statsFile = 'bot_stats.json';

// Base de datos estática de espejos (como respaldo)
const mirrorsDB = {
  'http://srdigital.win:8080': ['http://160125.xyz:80'],
  'http://line.premium-dino.com:80': [
    'http://mag.tvplus.cc:80',
    'http://ugotv.protv.cc:80',
    'http://pure-iptv.in:80',
    'http://line.premium-dino.com:80',
    'http://mag.premium-dino.com:80',
    'http://mag.mariopowers.com:80'
  ],
  'http://ultra-premium-pro.xyz:8080': ['http://ultra-premium-pro.xyz:8080']
};

// Mensaje fijo
const adminMessage = '\n\n👨‍💼 *Equipo de Administración EntresHijos*';

// Inicializar logs y estadísticas
if (!fs.existsSync(logsFile)) fs.writeFileSync(logsFile, JSON.stringify([]));
if (!fs.existsSync(statsFile)) fs.writeFileSync(statsFile, JSON.stringify({ totalChecks: 0, uniqueUsers: [], activeAlerts: 0 }));

// Cargar estadísticas con manejo de errores
function loadStats() {
  try {
    const loadedStats = JSON.parse(fs.readFileSync(statsFile));
    stats.totalChecks = loadedStats.totalChecks || 0;
    stats.activeAlerts = loadedStats.activeAlerts || 0;
    stats.uniqueUsers = new Set(Array.isArray(loadedStats.uniqueUsers) ? loadedStats.uniqueUsers : []);
  } catch (error) {
    console.error('Error al cargar estadísticas:', error.message);
    stats = { totalChecks: 0, uniqueUsers: new Set(), activeAlerts: 0 };
    saveStats();
  }
}

// Guardar estadísticas
function saveStats() {
  const statsToSave = { ...stats, uniqueUsers: Array.from(stats.uniqueUsers) };
  fs.writeFileSync(statsFile, JSON.stringify(statsToSave, null, 2));
}

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

// Obtener el nombre de usuario con @ o el nombre
function getUserMention(user) {
  return user.username ? `@${escapeMarkdown(user.username)}` : escapeMarkdown(user.first_name);
}

// Autoeliminar mensaje después de 5 minutos
async function autoDeleteMessage(chatId, messageId, threadId) {
  setTimeout(async () => {
    try {
      await bot.deleteMessage(chatId, messageId);
    } catch (error) {
      logAction('delete_message_error', { chatId, messageId, error: error.message });
    }
  }, 300000); // 5 minutos = 300,000 ms
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
  loadStats();
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
  const group = ALLOWED_CHAT_IDS.find(g => g.chatId === String(chatId));
  if (!group) return false;
  if (!group.active) return false; // No permitir si el grupo está inactivo
  return group.threadId ? String(threadId) === group.threadId : true;
}

// Obtener grupo por chatId
function getGroup(chatId) {
  return ALLOWED_CHAT_IDS.find(g => g.chatId === String(chatId));
}

// Generar posibles servidores espejo
async function generateMirrorServers(serverUrl) {
  try {
    const url = new URL(serverUrl);
    const domain = url.hostname; // Ejemplo: line.premium-dino.com
    const port = url.port || '80'; // Ejemplo: 80
    const baseDomain = domain.split('.').slice(-2).join('.'); // Ejemplo: premium-dino.com

    // Generar posibles variaciones
    const prefixes = ['mag', 'line', 'line2', 'iptv', 'pure', 'ultra', 'stream', 'tv', 'pro'];
    const domainsToTry = prefixes.map(prefix => `${prefix}.${baseDomain}:${port}`);

    const activeMirrors = [];
    for (const mirror of domainsToTry) {
      const mirrorUrl = `http://${mirror}`;
      try {
        const response = await axios.head(mirrorUrl, { timeout: 3000 });
        if (response.status === 200) {
          activeMirrors.push(mirrorUrl);
        }
      } catch (error) {
        // Ignorar errores (servidor no activo)
      }
    }
    return activeMirrors;
  } catch (error) {
    return [];
  }
}

// Verificar lista IPTV con más compatibilidad
async function checkIPTVList(url) {
  logAction('check_start', { url });
  try {
    url = url.trim();
    if (!url.startsWith('http')) url = `http://${url}`;

    // 1. Xtream Codes
    if (url.includes('get.php')) {
      const [, params] = url.split('?');
      const queryParams = Object.fromEntries(new URLSearchParams(params));
      const { username, password, output = 'm3u_plus' } = queryParams;
      const server = url.split('/get.php')[0];
      const apiUrl = `${server}/player_api.php?username=${username}&password=${password}`;

      const response = await axios.get(apiUrl, { timeout: 3000 });
      const { user_info, server_info } = response.data;
      const streams = await axios.get(`${apiUrl}&action=get_live_streams`, { timeout: 3000 });
      const vod = await axios.get(`${apiUrl}&action=get_vod_streams`, { timeout: 3000 });
      const series = await axios.get(`${apiUrl}&action=get_series`, { timeout: 3000 });

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
        channels: streams.data.slice(0, 10).map(s => s.name),
        movies: vod.data.slice(0, 5).map(v => v.name),
        series: series.data.slice(0, 5).map(s => s.name),
        totalChannels: streams.data.length,
        totalMovies: vod.data.length,
        totalSeries: series.data.length,
        timezone: server_info.timezone || 'Desconocida'
      };
    }

    // 2. M3U/M3U8
    if (url.endsWith('.m3u') || url.endsWith('.m3u8')) {
      const response = await axios.get(url, { timeout: 3000 });
      const lines = response.data.split('\n');
      const channels = lines.filter(line => line.startsWith('#EXTINF')).map(line => line.split(',')[1]?.trim() || 'Canal sin nombre').slice(0, 10);

      logAction('check_m3u_success', { url, channels: channels.length });
      return {
        type: 'M3U/M3U8',
        status: channels.length > 0 ? 'Activa' : 'Inactiva',
        channels,
        movies: [],
        series: [],
        totalChannels: lines.filter(line => line.startsWith('#EXTINF')).length,
        totalMovies: 0,
        totalSeries: 0,
        server: url
      };
    }

    // 3. Enlace directo (TS, HLS, etc.)
    if (url.endsWith('.ts') || url.includes('live') || url.includes('hls')) {
      const response = await axios.head(url, { timeout: 3000 });
      logAction('check_direct_success', { url });
      return {
        type: 'Enlace Directo',
        status: response.status === 200 ? 'Activa' : 'Inactiva',
        channels: ['Stream directo'],
        movies: [],
        series: [],
        totalChannels: 1,
        totalMovies: 0,
        totalSeries: 0,
        server: url
      };
    }

    // 4. Otros formatos (intento genérico)
    const response = await axios.head(url, { timeout: 3000 });
    logAction('check_generic_success', { url });
    return {
      type: 'Genérico',
      status: response.status === 200 ? 'Activa' : 'Inactiva',
      channels: ['Contenido no detallado'],
      movies: [],
      series: [],
      totalChannels: 1,
      totalMovies: 0,
      totalSeries: 0,
      server: url
    };
  } catch (error) {
    const errorMsg = error.response?.status === 404 ? 'Servidor no encontrado (404)' : error.message.includes('timeout') ? 'Tiempo agotado' : error.message;
    logAction('check_error', { url, error: errorMsg });
    return { type: 'Desconocido', status: 'Error', error: errorMsg, server: url };
  }
}

// Formatear respuesta profesional
function formatResponse(msg, result, previousMessageId = null) {
  const timestamp = new Date().toLocaleString('es-ES', { timeZone: 'America/Mexico_City' });
  const userMention = getUserMention(msg.from);

  let response = `✨ Hola ${userMention}, aquí tienes los detalles de tu lista IPTV gracias a *${botName}* ✨\n\n` +
    `⏳ *Verificado el*: ${timestamp}\n\n` +
    `📡 *Lista*: ${escapeMarkdown(result.server || 'N/A')}\n` +
    `${result.type === 'Xtream Codes' ? `🔧 *Player API*: ${escapeMarkdown(`${result.server}/player_api.php?username=${result.username}&password=${result.password}`)}\n` : ''}` +
    `📜 *Tipo*: ${result.type}\n` +
    `${result.status === 'Active' || result.status === 'Activa' ? '✅' : '❌'} *Estado*: ${result.status}\n` +
    `${result.username ? `👤 *Credenciales*: ${escapeMarkdown(result.username)}:${escapeMarkdown(result.password)}\n` : ''}` +
    `${result.createdAt ? `📅 *Creada*: ${result.createdAt}\n` : ''}` +
    `${result.expiresAt ? `⏰ *Expira*: ${result.expiresAt}\n` : ''}` +
    `${result.activeConnections !== undefined ? `🔗 *Conexiones activas*: ${result.activeConnections}\n` : ''}` +
    `${result.maxConnections !== undefined ? `🔗 *Conexiones máximas*: ${result.maxConnections}\n` : ''}` +
    `📊 *Total de canales*: ${result.totalChannels || 0}\n` +
    `🎬 *Total de películas*: ${result.totalMovies || 0}\n` +
    `📽 *Total de series*: ${result.totalSeries || 0}\n` +
    `${result.timezone ? `⏲ *Zona horaria*: ${result.timezone}\n` : ''}` +
    `${result.error ? `⚠️ *Error*: ${escapeMarkdown(result.error)}\n` : ''}` +
    `${result.error ? `💡 *Sugerencia*: Prueba con /espejos ${escapeMarkdown(result.server)} para buscar servidores alternativos.\n` : ''}\n` +
    `📺 *Canales (muestra)*: ${result.channels?.length > 0 ? result.channels.map(c => escapeMarkdown(c)).join(' 🌐 ') : 'No disponible'}\n` +
    `${result.channels?.length < result.totalChannels ? `*(+${result.totalChannels - result.channels.length} más)*` : ''}\n\n` +
    `🎬 *Películas (muestra)*: ${result.movies?.length > 0 ? result.movies.map(m => escapeMarkdown(m)).join(' 🌐 ') : 'No disponible'}\n` +
    `${result.movies?.length < result.totalMovies ? `*(+${result.totalMovies - result.movies.length} más)*` : ''}\n\n` +
    `📽 *Series (muestra)*: ${result.series?.length > 0 ? result.series.map(s => escapeMarkdown(s)).join(' 🌐 ') : 'No disponible'}\n` +
    `${result.series?.length < result.totalSeries ? `*(+${result.totalSeries - result.series.length} más)*` : ''}\n\n` +
    `🚀 *Potenciado por ${botName} - 100% Gratis*${adminMessage}`;

  return { text: response, replyTo: previousMessageId };
}

// Menú principal con botones
const mainMenu = {
  reply_markup: {
    inline_keyboard: [
      [{ text: '🔎 Verificar Lista', callback_data: 'check' }, { text: '📑 Historial', callback_data: 'history' }],
      [{ text: '⏱ Configurar Alerta', callback_data: 'alert' }, { text: 'ℹ️ Ayuda', callback_data: 'help' }],
      [{ text: '📊 Estadísticas', callback_data: 'stats' }, { text: '🗑 Limpiar Historial', callback_data: 'clear' }]
    ]
  }
};

// Comando /on
bot.onText(/\/on/, async (msg) => {
  const chatId = msg.chat.id;
  const threadId = msg.message_thread_id || '0';
  const userMention = getUserMention(msg.from);

  // Permitir siempre este comando, incluso en grupos inactivos
  const group = ALLOWED_CHAT_IDS.find(g => g.chatId === String(chatId));
  if (!group) {
    const message = await bot.sendMessage(chatId, `🚫 ${userMention}, este bot no está configurado para este grupo.${adminMessage}`, { message_thread_id: threadId, parse_mode: 'Markdown' });
    autoDeleteMessage(chatId, message.message_id, threadId);
    return;
  }

  const buttons = ALLOWED_CHAT_IDS.map(g => [{
    text: `${g.name} (${g.active ? '✅ Activo' : '❌ Inactivo'})`,
    callback_data: `activate_group_${g.chatId}`
  }]);

  const message = await bot.sendMessage(chatId, `🟢 ${userMention}, selecciona un grupo para activar el bot:${adminMessage}`, {
    parse_mode: 'Markdown',
    message_thread_id: threadId,
    reply_markup: { inline_keyboard: buttons }
  });
  autoDeleteMessage(chatId, message.message_id, threadId);
});

// Comando /off
bot.onText(/\/off/, async (msg) => {
  const chatId = msg.chat.id;
  const threadId = msg.message_thread_id || '0';
  const userMention = getUserMention(msg.from);

  // Permitir siempre este comando, incluso en grupos inactivos
  const group = ALLOWED_CHAT_IDS.find(g => g.chatId === String(chatId));
  if (!group) {
    const message = await bot.sendMessage(chatId, `🚫 ${userMention}, este bot no está configurado para este grupo.${adminMessage}`, { message_thread_id: threadId, parse_mode: 'Markdown' });
    autoDeleteMessage(chatId, message.message_id, threadId);
    return;
  }

  const buttons = ALLOWED_CHAT_IDS.map(g => [{
    text: `${g.name} (${g.active ? '✅ Activo' : '❌ Inactivo'})`,
    callback_data: `deactivate_group_${g.chatId}`
  }]);

  const message = await bot.sendMessage(chatId, `🔴 ${userMention}, selecciona un grupo para desactivar el bot:${adminMessage}`, {
    parse_mode: 'Markdown',
    message_thread_id: threadId,
    reply_markup: { inline_keyboard: buttons }
  });
  autoDeleteMessage(chatId, message.message_id, threadId);
});

// Manejo de botones de activación/desactivación
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const threadId = query.message.message_thread_id || '0';
  const userId = query.from.id;
  const messageId = query.message.message_id;
  const userMention = getUserMention(query.from);

  const action = query.data;

  // Manejo de activación/desactivación
  if (action.startsWith('activate_group_') || action.startsWith('deactivate_group_')) {
    const isActivation = action.startsWith('activate_group_');
    const groupId = action.split('_').pop();
    const group = ALLOWED_CHAT_IDS.find(g => g.chatId === groupId);

    if (!group) {
      const message = await bot.sendMessage(chatId, `❌ ${userMention}, grupo no encontrado.${adminMessage}`, { message_thread_id: threadId, parse_mode: 'Markdown' });
      autoDeleteMessage(chatId, message.message_id, threadId);
      return;
    }

    if ((isActivation && group.active) || (!isActivation && !group.active)) {
      const message = await bot.sendMessage(chatId, `ℹ️ ${userMention}, el bot ya está ${isActivation ? 'activo' : 'inactivo'} en ${group.name}.${adminMessage}`, { message_thread_id: threadId, parse_mode: 'Markdown' });
      autoDeleteMessage(chatId, message.message_id, threadId);
      return;
    }

    const confirmButtons = [
      [{ text: '✅ Confirmar', callback_data: `confirm_${action}` }],
      [{ text: '❌ Cancelar', callback_data: `cancel_${groupId}` }]
    ];

    const message = await bot.sendMessage(chatId, `⚠️ ${userMention}, ¿estás seguro de ${isActivation ? 'activar' : 'desactivar'} el bot en ${group.name}?${adminMessage}`, {
      parse_mode: 'Markdown',
      message_thread_id: threadId,
      reply_markup: { inline_keyboard: confirmButtons }
    });
    autoDeleteMessage(chatId, message.message_id, threadId);
    await bot.answerCallbackQuery(query.id);
    return;
  }

  // Manejo de confirmación/cancelación
  if (action.startsWith('confirm_')) {
    const originalAction = action.replace('confirm_', '');
    const isActivation = originalAction.startsWith('activate_group_');
    const groupId = originalAction.split('_').pop();
    const group = ALLOWED_CHAT_IDS.find(g => g.chatId === groupId);

    if (!group) return;

    group.active = isActivation;
    const message = await bot.sendMessage(chatId, `${isActivation ? '🟢' : '🔴'} ${userMention}, el bot ha sido ${isActivation ? 'activado' : 'desactivado'} en ${group.name}.${adminMessage}`, {
      parse_mode: 'Markdown',
      message_thread_id: threadId
    });
    autoDeleteMessage(chatId, message.message_id, threadId);
    await bot.answerCallbackQuery(query.id);
    return;
  }

  if (action.startsWith('cancel_')) {
    const groupId = action.split('_').pop();
    const group = ALLOWED_CHAT_IDS.find(g => g.chatId === groupId);
    if (!group) return;

    const message = await bot.sendMessage(chatId, `ℹ️ ${userMention}, acción cancelada para ${group.name}.${adminMessage}`, {
      parse_mode: 'Markdown',
      message_thread_id: threadId
    });
    autoDeleteMessage(chatId, message.message_id, threadId);
    await bot.answerCallbackQuery(query.id);
    return;
  }

  // Verificar si el grupo está activo antes de procesar otras acciones
  if (!isAllowedContext(chatId, threadId)) return;

  // Otras acciones de botones (check, history, etc.)
  try {
    if (action === 'check') {
      const message = await bot.sendMessage(chatId, `🔎 ${userMention}, envía un enlace IPTV para verificar (M3U, Xtream, TS, etc.):${adminMessage}`, { message_thread_id: threadId, parse_mode: 'Markdown', reply_to_message_id: messageId });
      autoDeleteMessage(chatId, message.message_id, threadId);
    } else if (action === 'history') {
      if (!userHistory[userId] || userHistory[userId].length === 0) {
        const message = await bot.sendMessage(chatId, `📑 ${userMention}, tu historial está vacío. Verifica una lista primero.${adminMessage}`, { message_thread_id: threadId, parse_mode: 'Markdown', reply_to_message_id: messageId, ...mainMenu });
        autoDeleteMessage(chatId, message.message_id, threadId);
      } else {
        const history = userHistory[userId].slice(-5).map(h => `📡 ${escapeMarkdown(h.url)}\n${h.result.status === 'Active' || h.result.status === 'Activa' ? '✅' : '❌'} ${h.result.status}\n⏳ ${h.timestamp.toLocaleString('es-ES')}`).join('\n\n');
        const message = await bot.sendMessage(chatId, `📑 ${userMention}, aquí tienes tus últimas 5 verificaciones:\n\n${history}${adminMessage}`, { parse_mode: 'Markdown', message_thread_id: threadId, reply_to_message_id: messageId, ...mainMenu });
        autoDeleteMessage(chatId, message.message_id, threadId);
      }
    } else if (action === 'alert') {
      const message = await bot.sendMessage(chatId, `⏱ ${userMention}, envía un enlace IPTV seguido de los días para la alerta:\nEjemplo: http://server.com/get.php?username=xxx&password=yyy 3${adminMessage}`, { message_thread_id: threadId, parse_mode: 'Markdown', reply_to_message_id: messageId });
      autoDeleteMessage(chatId, message.message_id, threadId);
    } else if (action === 'help') {
      const message = await bot.sendMessage(chatId, `ℹ️ ${userMention}, aquí tienes la ayuda de *${botName}* ℹ️\n\n- Envía un enlace IPTV para verificarlo.\n- Usa /iptv para el menú.\n- Gratis y sin límites.\n- Usa /guia para más detalles.${adminMessage}`, { parse_mode: 'Markdown', message_thread_id: threadId, reply_to_message_id: messageId, ...mainMenu });
      autoDeleteMessage(chatId, message.message_id, threadId);
    } else if (action === 'stats') {
      const response = `📊 *Estadísticas de ${botName}* para ${userMention} 📊\n\n` +
        `🔍 *Verificaciones totales*: ${stats.totalChecks}\n` +
        `👥 *Usuarios únicos*: ${stats.uniqueUsers.size}\n` +
        `⏱ *Alertas activas*: ${stats.activeAlerts}\n\n` +
        `🚀 *Potenciado por ${botName} - 100% Gratis*${adminMessage}`;
      const message = await bot.sendMessage(chatId, response, { parse_mode: 'Markdown', message_thread_id: threadId, reply_to_message_id: messageId, ...mainMenu });
      autoDeleteMessage(chatId, message.message_id, threadId);
    } else if (action === 'clear') {
      if (userHistory[userId]) {
        delete userHistory[userId];
        const message = await bot.sendMessage(chatId, `🗑 ${userMention}, tu historial de verificaciones ha sido limpiado.${adminMessage}`, { parse_mode: 'Markdown', message_thread_id: threadId, reply_to_message_id: messageId, ...mainMenu });
        autoDeleteMessage(chatId, message.message_id, threadId);
      } else {
        const message = await bot.sendMessage(chatId, `🗑 ${userMention}, no tienes historial para limpiar.${adminMessage}`, { parse_mode: 'Markdown', message_thread_id: threadId, reply_to_message_id: messageId, ...mainMenu });
        autoDeleteMessage(chatId, message.message_id, threadId);
      }
    }
    await bot.answerCallbackQuery(query.id);
  } catch (error) {
    logAction('callback_error', { action, error: error.message });
    const message = await bot.sendMessage(chatId, `❌ ${userMention}, ocurrió un error: ${error.message}${adminMessage}`, { message_thread_id: threadId, parse_mode: 'Markdown', reply_to_message_id: messageId });
    autoDeleteMessage(chatId, message.message_id, threadId);
  }
});

// Comando /iptv
bot.onText(/\/iptv/, async (msg) => {
  const chatId = msg.chat.id;
  const threadId = msg.message_thread_id || '0';
  const userMention = getUserMention(msg.from);

  if (!isAllowedContext(chatId, threadId)) {
    const group = getGroup(chatId);
    if (group && !group.active) {
      const message = await bot.sendMessage(chatId, `🚫 ${userMention}, el bot está desactivado en este grupo. Usa /on para activarlo.${adminMessage}`, { message_thread_id: threadId, parse_mode: 'Markdown' });
      autoDeleteMessage(chatId, message.message_id, threadId);
    }
    return;
  }

  const message = await bot.sendMessage(chatId, `🌟 ¡Bienvenido ${userMention} a *${botName}*! 🌟\n\nSoy un bot gratuito para verificar listas IPTV. Usa los botones o envía un enlace directamente.\n\n*Comandos disponibles*:\n/iptv - Iniciar\n/guia - Ayuda\n/espejos - Buscar servidores alternativos\n/stats - Ver estadísticas\n/limpiar - Borrar tu historial\n/on - Activar bot\n/off - Desactivar bot${adminMessage}`, {
    parse_mode: 'Markdown',
    message_thread_id: threadId,
    ...mainMenu
  });
  autoDeleteMessage(chatId, message.message_id, threadId);
});

// Comando /guia
bot.onText(/\/guia/, async (msg) => {
  const chatId = msg.chat.id;
  const threadId = msg.message_thread_id || '0';
  const userMention = getUserMention(msg.from);

  if (!isAllowedContext(chatId, threadId)) return;

  const helpMessage = `📖 *Guía de ${botName}* para ${userMention} 📖\n\n` +
    `✨ *¿Para qué sirve este bot?*\n` +
    `Soy un bot diseñado para ayudarte a gestionar y verificar listas IPTV de forma gratuita. Puedo analizar el estado de tus listas, buscar servidores alternativos (espejos) si un servidor falla, configurar alertas de expiración y más.\n\n` +
    `🔧 *¿Cómo funciona?*\n` +
    `- Usa /iptv para iniciar y ver el menú.\n` +
    `- Envía un enlace IPTV para verificarlo (o usa el botón 🔎).\n` +
    `- Si un servidor falla, usa /espejos para buscar alternativas.\n` +
    `- Configura alertas de expiración con el botón ⏱.\n` +
    `- Todos los mensajes se eliminan automáticamente después de 5 minutos para mantener el canal limpio.\n\n` +
    `📋 *Tipos de listas compatibles*:\n` +
    `- *Xtream Codes*: Ejemplo: http://server.com/get.php?username=xxx&password=yyy\n` +
    `- *M3U/M3U8*: Ejemplo: http://server.com/playlist.m3u\n` +
    `- *Enlaces directos (TS/HLS)*: Ejemplo: http://server.com/stream.ts\n` +
    `- *Genérico*: Cualquier URL que pueda verificarse.\n\n` +
    `📜 *Comandos disponibles*:\n` +
    `/iptv - Iniciar el bot\n` +
    `/guia - Ver esta guía\n` +
    `/espejos <servidor> - Buscar servidores alternativos (espejos)\n` +
    `/stats - Ver estadísticas del bot\n` +
    `/limpiar - Borrar tu historial de verificaciones\n` +
    `/on - Activar el bot en un grupo\n` +
    `/off - Desactivar el bot en un grupo\n\n` +
    `💡 *Ejemplo de uso*:\n` +
    `- Verificar: http://server.com/get.php?username=xxx&password=yyy\n` +
    `- Buscar espejos: /espejos http://srdigital.win:8080\n` +
    `¡Explora y disfruta de un servicio 100% gratis!${adminMessage}`;

  await bot.sendMessage(chatId, helpMessage, {
    parse_mode: 'Markdown',
    message_thread_id: threadId,
    ...mainMenu
  });
  // No se autoelimina para que la guía permanezca visible
});

// Comando /espejos
bot.onText(/\/espejos\s+(.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const threadId = msg.message_thread_id || '0';
  const userMention = getUserMention(msg.from);
  const server = match[1].trim();

  if (!isAllowedContext(chatId, threadId)) return;

  const checkingMessage = await bot.sendMessage(chatId, `🪞 ${userMention}, buscando servidores espejo para ${escapeMarkdown(server)}...${adminMessage}`, {
    parse_mode: 'Markdown',
    message_thread_id: threadId
  });
  autoDeleteMessage(chatId, checkingMessage.message_id, threadId);

  // Buscar servidores espejo dinámicamente
  let mirrors = await generateMirrorServers(server);

  // Si no se encuentran espejos dinámicamente, usar la base de datos estática
  if (mirrors.length === 0) {
    mirrors = mirrorsDB[server] || [];
  }

  let response;
  if (mirrors.length > 0) {
    response = `🪞 ${userMention}, aquí tienes los servidores espejo para ${escapeMarkdown(server)}:\n\n` +
      mirrors.map(m => `- ${escapeMarkdown(m)}`).join('\n') + adminMessage;
  } else {
    response = `🪞 ${userMention}, no se encontraron servidores espejo para ${escapeMarkdown(server)}.\n` +
      `💡 Intenta con otro servidor o contacta al soporte.${adminMessage}`;
  }

  const message = await bot.sendMessage(chatId, response, {
    parse_mode: 'Markdown',
    message_thread_id: threadId
  });
  autoDeleteMessage(chatId, message.message_id, threadId);
});

// Comando /stats
bot.onText(/\/stats/, async (msg) => {
  const chatId = msg.chat.id;
  const threadId = msg.message_thread_id || '0';
  const userMention = getUserMention(msg.from);

  if (!isAllowedContext(chatId, threadId)) return;

  const response = `📊 *Estadísticas de ${botName}* para ${userMention} 📊\n\n` +
    `🔍 *Verificaciones totales*: ${stats.totalChecks}\n` +
    `👥 *Usuarios únicos*: ${stats.uniqueUsers.size}\n` +
    `⏱ *Alertas activas*: ${stats.activeAlerts}\n\n` +
    `🚀 *Potenciado por ${botName} - 100% Gratis*${adminMessage}`;

  const message = await bot.sendMessage(chatId, response, {
    parse_mode: 'Markdown',
    message_thread_id: threadId,
    ...mainMenu
  });
  autoDeleteMessage(chatId, message.message_id, threadId);
});

// Comando /limpiar
bot.onText(/\/limpiar/, async (msg) => {
  const chatId = msg.chat.id;
  const threadId = msg.message_thread_id || '0';
  const userId = msg.from.id;
  const userMention = getUserMention(msg.from);

  if (!isAllowedContext(chatId, threadId)) return;

  if (userHistory[userId]) {
    delete userHistory[userId];
    const response = `🗑 ${userMention}, tu historial de verificaciones ha sido limpiado.${adminMessage}`;
    const message = await bot.sendMessage(chatId, response, {
      parse_mode: 'Markdown',
      message_thread_id: threadId,
      ...mainMenu
    });
    autoDeleteMessage(chatId, message.message_id, threadId);
  } else {
    const response = `🗑 ${userMention}, no tienes historial para limpiar.${adminMessage}`;
    const message = await bot.sendMessage(chatId, response, {
      parse_mode: 'Markdown',
      message_thread_id: threadId,
      ...mainMenu
    });
    autoDeleteMessage(chatId, message.message_id, threadId);
  }
});

// Procesar mensajes con URLs IPTV o alertas
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const threadId = msg.message_thread_id || '0';
  const userId = msg.from.id;
  const text = msg.text || '';
  const replyToMessage = msg.reply_to_message;
  const userMention = getUserMention(msg.from);

  // Permitir /on y /off incluso en grupos inactivos
  if (text.startsWith('/on') || text.startsWith('/off')) return;

  if (!isAllowedContext(chatId, threadId)) return;

  const isIPTVUrl = text.match(/http[s]?:\/\/[^\s]+(get\.php|\.m3u|\.m3u8|\.ts|hls)/i);
  const replyToBot = replyToMessage && replyToMessage.from.id === bot.id;

  try {
    if (isIPTVUrl) {
      const url = text.split(' ')[0];
      const days = text.split(' ')[1] || null;
      const previousMessageId = replyToBot ? replyToMessage.message_id : null;

      stats.totalChecks++;
      stats.uniqueUsers.add(userId);
      saveStats();

      const checking = await bot.sendMessage(chatId, `🔎 ${userMention}, verificando ${escapeMarkdown(url)}...${adminMessage}`, { message_thread_id: threadId, parse_mode: 'Markdown', reply_to_message_id: previousMessageId });
      autoDeleteMessage(chatId, checking.message_id, threadId);

      const result = await checkIPTVList(url);

      if (!userHistory[userId]) userHistory[userId] = [];
      userHistory[userId].push({ url, result, timestamp: new Date() });

      const { text: response, replyTo } = formatResponse(msg, result, checking.message_id);
      const message = await bot.sendMessage(chatId, response, { parse_mode: 'Markdown', message_thread_id: threadId, reply_to_message_id: replyTo });
      autoDeleteMessage(chatId, message.message_id, threadId);

      const reaction = await bot.sendMessage(chatId, result.status === 'Active' || result.status === 'Activa' ? '✅' : '❌', { message_thread_id: threadId, reply_to_message_id: replyTo });
      autoDeleteMessage(chatId, reaction.message_id, threadId);

      if (days && replyToMessage?.text?.includes('⏱')) {
        if (result.expiresAt && result.expiresAt !== 'Ilimitada') {
          alerts[userId] = { url, expiresAt: new Date(result.expiresAt), notifyDaysBefore: parseInt(days) };
          stats.activeAlerts = Object.keys(alerts).length;
          saveStats();
          const alertMessage = await bot.sendMessage(chatId, `⏱ ${userMention}, alerta configurada para ${escapeMarkdown(url)} (${days} días antes).${adminMessage}`, { message_thread_id: threadId, parse_mode: 'Markdown', reply_to_message_id: replyTo });
          autoDeleteMessage(chatId, alertMessage.message_id, threadId);
        } else {
          const errorMessage = await bot.sendMessage(chatId, `❌ ${userMention}, no se puede configurar alerta: Lista ilimitada o sin fecha de expiración.${adminMessage}`, { message_thread_id: threadId, parse_mode: 'Markdown', reply_to_message_id: replyTo });
          autoDeleteMessage(chatId, errorMessage.message_id, threadId);
        }
      }
    }
  } catch (error) {
    logAction('message_error', { userId, text, error: error.message });
    const previousMessageId = replyToBot ? replyToMessage.message_id : null;
    const errorMessage = await bot.sendMessage(chatId, `❌ ${userMention}, ocurrió un error: ${error.message}${adminMessage}`, { message_thread_id: threadId, parse_mode: 'Markdown', reply_to_message_id: previousMessageId });
    autoDeleteMessage(chatId, errorMessage.message_id, threadId);
  }
});

// Alertas diarias (9:00 AM)
cron.schedule('0 9 * * *', async () => {
  for (const userId in alerts) {
    const { url, expiresAt, notifyDaysBefore } = alerts[userId];
    const daysLeft = Math.ceil((expiresAt - new Date()) / (1000 * 60 * 60 * 24));
    if (daysLeft <= notifyDaysBefore) {
      const userInfo = await bot.getChatMember(ALLOWED_CHAT_IDS[0].chatId, userId);
      const userMention = getUserMention(userInfo.user);

      for (const group of ALLOWED_CHAT_IDS) {
        if (!group.active) continue;

        const message = await bot.sendMessage(group.chatId, `⏱ *Alerta* para ${userMention}:\n${escapeMarkdown(url)} expira en ${daysLeft} días (${expiresAt.toLocaleString('es-ES')}).${adminMessage}`, {
          message_thread_id: group.threadId,
          parse_mode: 'Markdown'
        });
        autoDeleteMessage(group.chatId, message.message_id, group.threadId);

        const reaction = await bot.sendMessage(group.chatId, `⚠️`, { message_thread_id: group.threadId });
        autoDeleteMessage(group.chatId, reaction.message_id, group.threadId);
      }

      logAction('alerta_enviada', { userId, url, daysLeft });
    }
  }
});

console.log(`🚀 ${botName} iniciado 🎉`);