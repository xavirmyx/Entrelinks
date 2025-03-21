const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const cron = require('node-cron');
const fs = require('fs');
const axios = require('axios');
const cheerio = require('cheerio');

// Token del bot y nombre
const token = '7861676131:AAFLv4dBIFiHV1OYc8BJH2U8kWPal7lpBMQ';
const bot = new TelegramBot(token);
const botName = 'EntreCheck_iptv';

// Configuración de Express
const app = express();
const port = process.env.PORT || 10000;
app.use(express.json());

// Webhook
const webhookUrl = 'https://entrelinks.onrender.com';

// IDs permitidos y estado de grupos
const ALLOWED_CHAT_IDS = [
  { chatId: '-1002348662107', threadId: '53411', name: 'EntresHijos', active: true },
  { chatId: '-1002565012502', threadId: null, name: 'BotChecker_IPTV_ParaG', active: true }
];

// Almacenar datos
let userHistory = {};
let commandHistory = {}; // Nuevo: Historial de comandos para navegación
let alerts = {};
let backups = {};
let stats = { totalChecks: 0, uniqueUsers: new Set(), activeAlerts: 0 };
const logsFile = 'bot_logs.json';
const statsFile = 'bot_stats.json';

// Logs de render (proporcionados)
const renderLogs = `==> Running 'npm start'
> entrecheck-iptv@1.0.0 start
> node index.js
🚀 EntreCheck_iptv iniciado 🎉
🚀 Servidor en puerto 10000
[20/3/2025, 23:57:59] webhook_set: {
  url: 'https://entrelinks.onrender.com/bot7861676131:AAFLv4dBIFiHV1OYc8BJH2U8kWPal7lpBMQ'
}
[20/3/2025, 23:58:03] webhook_received: {
  update: {
    update_id: 626025150,
    message: {
      message_id: 24,
      from: [Object],
      chat: [Object],
      date: 1742515060,
      text: '/espejos http://amepz.xyz:8080',
      entities: [Array],
      link_preview_options: [Object]
    }
  }
}
[20/3/2025, 23:58:03] free_iptv_error: { error: 'Request failed with status code 404' }
==> Detected service running on port 10000
==> Docs on specifying a port: https://render.com/docs/web-services#port-binding`;

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

// Animación de "cargando" con emojis
async function showLoadingAnimation(chatId, threadId, messageId, baseText, duration) {
  const frames = ['🔍', '⏳', '🔎'];
  let frameIndex = 0;

  for (let i = 0; i < duration / 500; i++) {
    const frame = frames[frameIndex % frames.length];
    await bot.editMessageText(`${baseText} ${frame}`, {
      chat_id: chatId,
      message_id: messageId,
      message_thread_id: threadId,
      parse_mode: 'Markdown'
    });
    frameIndex++;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
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
  if (!group.active) return false;
  return group.threadId ? String(threadId) === group.threadId : true;
}

// Obtener grupo por chatId
function getGroup(chatId) {
  return ALLOWED_CHAT_IDS.find(g => g.chatId === String(chatId));
}

// Generar posibles servidores espejo (simulando FastoTV)
async function generateMirrorServers(serverUrl) {
  try {
    const url = new URL(serverUrl);
    const domain = url.hostname;
    const port = url.port || '80';
    const baseDomain = domain.split('.').slice(-2).join('.');

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

// Consultar iptvcat.com para buscar servidores espejo
async function searchMirrorsFromIPTVCat(serverUrl) {
  try {
    const url = new URL(serverUrl);
    const domain = url.hostname;
    const baseDomain = domain.split('.').slice(-2).join('.');

    const response = await axios.get('https://iptvcat.com/home_22', { timeout: 5000 });
    const $ = cheerio.load(response.data);
    const mirrors = [];

    $('a[href^="http"]').each((i, element) => {
      const link = $(element).attr('href');
      try {
        const mirrorUrl = new URL(link);
        const mirrorDomain = mirrorUrl.hostname;
        if (mirrorDomain.includes(baseDomain) && mirrorUrl.href !== serverUrl) {
          mirrors.push(mirrorUrl.href);
        }
      } catch (error) {
        // Ignorar URLs mal formadas
      }
    });

    const activeMirrors = [];
    for (const mirror of mirrors) {
      try {
        const headResponse = await axios.head(mirror, { timeout: 3000 });
        if (headResponse.status === 200) {
          activeMirrors.push(mirror);
        }
      } catch (error) {
        // Ignorar servidores inactivos
      }
    }
    return activeMirrors;
  } catch (error) {
    logAction('iptvcat_error', { error: error.message });
    return [];
  }
}

// Consultar Free-IPTV en GitHub
async function searchMirrorsFromFreeIPTV(serverUrl) {
  try {
    const url = new URL(serverUrl);
    const domain = url.hostname;
    const baseDomain = domain.split('.').slice(-2).join('.');

    const m3uUrl = 'https://raw.githubusercontent.com/Free-IPTV/Countries/master/World.m3u';
    const response = await axios.get(m3uUrl, { timeout: 5000 });
    const lines = response.data.split('\n');

    const mirrors = [];
    for (const line of lines) {
      if (line.startsWith('http')) {
        try {
          const mirrorUrl = new URL(line.trim());
          const mirrorDomain = mirrorUrl.hostname;
          if (mirrorDomain.includes(baseDomain) && mirrorUrl.href !== serverUrl) {
            try {
              const headResponse = await axios.head(mirrorUrl.href, { timeout: 3000 });
              if (headResponse.status === 200) {
                mirrors.push(mirrorUrl.href);
              }
            } catch (error) {
              // Ignorar servidores inactivos
            }
          }
        } catch (error) {
          // Ignorar líneas mal formadas
        }
      }
    }
    return mirrors;
  } catch (error) {
    logAction('free_iptv_error', { error: error.message });
    return [];
  }
}

// Consultar iptv-org.github.io
async function searchMirrorsFromIPTVOrg(serverUrl) {
  try {
    const url = new URL(serverUrl);
    const domain = url.hostname;
    const baseDomain = domain.split('.').slice(-2).join('.');

    const m3uUrl = 'https://iptv-org.github.io/iptv/index.m3u';
    const response = await axios.get(m3uUrl, { timeout: 5000 });
    const lines = response.data.split('\n');

    const mirrors = [];
    for (const line of lines) {
      if (line.startsWith('http')) {
        try {
          const mirrorUrl = new URL(line.trim());
          const mirrorDomain = mirrorUrl.hostname;
          if (mirrorDomain.includes(baseDomain) && mirrorUrl.href !== serverUrl) {
            try {
              const headResponse = await axios.head(mirrorUrl.href, { timeout: 3000 });
              if (headResponse.status === 200) {
                mirrors.push(mirrorUrl.href);
              }
            } catch (error) {
              // Ignorar servidores inactivos
            }
          }
        } catch (error) {
          // Ignorar líneas mal formadas
        }
      }
    }
    return mirrors;
  } catch (error) {
    logAction('iptv_org_error', { error: error.message });
    return [];
  }
}

// Nueva función: Buscar el comando /espejo en sitios externos
async function searchMirrorsInExternalSites(serverUrl) {
  const urlsToSearch = [
    'https://stbstalker.alaaeldinee.com/?m=1',
    'https://sat-forum.net/viewtopic.php?t=860&start=510'
  ];
  const results = [];

  for (const url of urlsToSearch) {
    try {
      const response = await axios.get(url, { timeout: 5000 });
      const $ = cheerio.load(response.data);

      // Buscar menciones de /espejo o /espejos
      const text = $('body').text();
      if (text.includes('/espejo') || text.includes('/espejos')) {
        results.push(`Encontrado en ${url}: /espejo o /espejos mencionado.`);
      } else {
        results.push(`No encontrado en ${url}.`);
      }
    } catch (error) {
      logAction('external_site_error', { url, error: error.message });
      results.push(`Error al buscar en ${url}: ${error.message}`);
    }
  }

  return results;
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

// Escanear lista IPTV para estadísticas detalladas
async function scanIPTVList(url) {
  try {
    url = url.trim();
    if (!url.startsWith('http')) url = `http://${url}`;

    let result = { activeChannels: 0, inactiveChannels: 0, categories: {}, totalChannels: 0, totalMovies: 0, totalSeries: 0 };

    // 1. Xtream Codes
    if (url.includes('get.php')) {
      const [, params] = url.split('?');
      const queryParams = Object.fromEntries(new URLSearchParams(params));
      const { username, password } = queryParams;
      const server = url.split('/get.php')[0];
      const apiUrl = `${server}/player_api.php?username=${username}&password=${password}`;

      const response = await axios.get(apiUrl, { timeout: 3000 });
      const { user_info } = response.data;
      const streams = await axios.get(`${apiUrl}&action=get_live_streams`, { timeout: 3000 });
      const vod = await axios.get(`${apiUrl}&action=get_vod_streams`, { timeout: 3000 });
      const series = await axios.get(`${apiUrl}&action=get_series`, { timeout: 3000 });

      result.totalChannels = streams.data.length;
      result.totalMovies = vod.data.length;
      result.totalSeries = series.data.length;

      for (const stream of streams.data.slice(0, 50)) {
        try {
          const streamUrl = `${server}/live/${username}/${password}/${stream.stream_id}.ts`;
          const headResponse = await axios.head(streamUrl, { timeout: 2000 });
          if (headResponse.status === 200) result.activeChannels++;
          else result.inactiveChannels++;
        } catch (error) {
          result.inactiveChannels++;
        }
      }

      streams.data.forEach(stream => {
        const category = stream.category_name || 'Sin categoría';
        result.categories[category] = (result.categories[category] || 0) + 1;
      });

      return result;
    }

    // 2. M3U/M3U8
    if (url.endsWith('.m3u') || url.endsWith('.m3u8')) {
      const response = await axios.get(url, { timeout: 3000 });
      const lines = response.data.split('\n');
      const channelLines = lines.filter(line => line.startsWith('#EXTINF'));

      result.totalChannels = channelLines.length;

      for (let i = 0; i < Math.min(channelLines.length, 50); i++) {
        const channelLine = channelLines[i];
        const streamUrl = lines[lines.indexOf(channelLine) + 1];
        if (!streamUrl || !streamUrl.startsWith('http')) continue;

        try {
          const headResponse = await axios.head(streamUrl, { timeout: 2000 });
          if (headResponse.status === 200) result.activeChannels++;
          else result.inactiveChannels++;
        } catch (error) {
          result.inactiveChannels++;
        }
      }

      channelLines.forEach(line => {
        const categoryMatch = line.match(/group-title="([^"]+)"/);
        const category = categoryMatch ? categoryMatch[1] : 'Sin categoría';
        result.categories[category] = (result.categories[category] || 0) + 1;
      });

      return result;
    }

    return result;
  } catch (error) {
    logAction('scan_error', { url, error: error.message });
    return { error: error.message };
  }
}

// Realizar prueba de velocidad
async function speedTestIPTV(url) {
  try {
    url = url.trim();
    if (!url.startsWith('http')) url = `http://${url}`;

    const startTime = Date.now();
    const response = await axios.head(url, { timeout: 5000 });
    const latency = Date.now() - startTime;

    let downloadSpeed = 'No disponible';
    if (url.endsWith('.ts') || url.includes('hls')) {
      const startDownload = Date.now();
      const { data } = await axios.get(url, { responseType: 'stream', timeout: 5000, maxContentLength: 1024 * 1024 });
      const endDownload = Date.now();
      const downloadTime = (endDownload - startDownload) / 1000;
      const sizeInMB = 1;
      downloadSpeed = ((sizeInMB * 8) / downloadTime).toFixed(2) + ' Mbps';
    }

    return { latency: `${latency} ms`, downloadSpeed };
  } catch (error) {
    logAction('speedtest_error', { url, error: error.message });
    return { error: error.message };
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

// Menú principal mejorado con botones profesionales
const mainMenu = {
  reply_markup: {
    inline_keyboard: [
      [
        { text: '🔎 Verificar Lista', callback_data: 'check' },
        { text: '🪞 Buscar Espejos', callback_data: 'mirrors' },
        { text: '📑 Historial', callback_data: 'history' }
      ],
      [
        { text: '⏱ Configurar Alerta', callback_data: 'alert' },
        { text: '📊 Escanear Lista', callback_data: 'scan' },
        { text: '⚡ Prueba de Velocidad', callback_data: 'speedtest' }
      ],
      [
        { text: '🆚 Comparar Listas', callback_data: 'compare' },
        { text: '💾 Hacer Backup', callback_data: 'backup' },
        { text: '🗑 Limpiar Historial', callback_data: 'clear' }
      ],
      [
        { text: '📈 Estadísticas', callback_data: 'stats' },
        { text: '📜 Ver Logs', callback_data: 'logs' },
        { text: 'ℹ️ Ayuda', callback_data: 'help' }
      ]
    ]
  }
};

// Función para añadir botones de navegación
function addNavigationButtons(userId, currentIndex) {
  if (!commandHistory[userId] || commandHistory[userId].length === 0) return {};
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '⬅️ Anterior', callback_data: `navigate_prev_${currentIndex}` },
          { text: 'Siguiente ➡️', callback_data: `navigate_next_${currentIndex}` }
        ]
      ]
    }
  };
}

// Comando /on
bot.onText(/\/on/, async (msg) => {
  const chatId = msg.chat.id;
  const threadId = msg.message_thread_id || '0';
  const userMention = getUserMention(msg.from);

  const group = ALLOWED_CHAT_IDS.find(g => g.chatId === String(chatId));
  if (!group) {
    const message = await bot.sendMessage(chatId, `🚫 ${userMention}, este bot no está configurado para este grupo. 📩 Contacta al soporte.${adminMessage}`, { message_thread_id: threadId, parse_mode: 'Markdown' });
    autoDeleteMessage(chatId, message.message_id, threadId);
    return;
  }

  const buttons = ALLOWED_CHAT_IDS.map(g => [{
    text: `${g.name} (${g.active ? '✅ Activo' : '❌ Inactivo'})`,
    callback_data: `activate_group_${g.chatId}`
  }]);

  const message = await bot.sendMessage(chatId, `🟢 ${userMention}, selecciona un grupo para activar el bot: 🚀${adminMessage}`, {
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

  const group = ALLOWED_CHAT_IDS.find(g => g.chatId === String(chatId));
  if (!group) {
    const message = await bot.sendMessage(chatId, `🚫 ${userMention}, este bot no está configurado para este grupo. 📩 Contacta al soporte.${adminMessage}`, { message_thread_id: threadId, parse_mode: 'Markdown' });
    autoDeleteMessage(chatId, message.message_id, threadId);
    return;
  }

  const buttons = ALLOWED_CHAT_IDS.map(g => [{
    text: `${g.name} (${g.active ? '✅ Activo' : '❌ Inactivo'})`,
    callback_data: `deactivate_group_${g.chatId}`
  }]);

  const message = await bot.sendMessage(chatId, `🔴 ${userMention}, selecciona un grupo para desactivar el bot: 🛑${adminMessage}`, {
    parse_mode: 'Markdown',
    message_thread_id: threadId,
    reply_markup: { inline_keyboard: buttons }
  });
  autoDeleteMessage(chatId, message.message_id, threadId);
});

// Manejo de botones
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const threadId = query.message.message_thread_id || '0';
  const userId = query.from.id;
  const messageId = query.message.message_id;
  const userMention = getUserMention(query.from);

  const action = query.data;

  // Manejo de navegación
  if (action.startsWith('navigate_prev_') || action.startsWith('navigate_next_')) {
    const direction = action.startsWith('navigate_prev_') ? 'prev' : 'next';
    let currentIndex = parseInt(action.split('_').pop());
    if (direction === 'prev' && currentIndex > 0) {
      currentIndex--;
    } else if (direction === 'next' && currentIndex < commandHistory[userId].length - 1) {
      currentIndex++;
    }

    const commandEntry = commandHistory[userId][currentIndex];
    let responseText = commandEntry.response;
    if (commandEntry.command === '/logs') {
      responseText = `📜 *Logs de Render* 📜\n\n\`\`\`\n${renderLogs}\n\`\`\`\n\n🚀 *Potenciado por ${botName} - 100% Gratis*${adminMessage}`;
    }

    await bot.editMessageText(responseText, {
      chat_id: chatId,
      message_id: messageId,
      message_thread_id: threadId,
      parse_mode: 'Markdown',
      ...addNavigationButtons(userId, currentIndex)
    });
    await bot.answerCallbackQuery(query.id);
    return;
  }

  // Manejo de activación/desactivación
  if (action.startsWith('activate_group_') || action.startsWith('deactivate_group_')) {
    const isActivation = action.startsWith('activate_group_');
    const groupId = action.split('_').pop();
    const group = ALLOWED_CHAT_IDS.find(g => g.chatId === groupId);

    if (!group) {
      const message = await bot.sendMessage(chatId, `❌ ${userMention}, grupo no encontrado. 📩 Contacta al soporte.${adminMessage}`, { message_thread_id: threadId, parse_mode: 'Markdown' });
      autoDeleteMessage(chatId, message.message_id, threadId);
      return;
    }

    if ((isActivation && group.active) || (!isActivation && !group.active)) {
      const message = await bot.sendMessage(chatId, `ℹ️ ${userMention}, el bot ya está ${isActivation ? 'activo' : 'inactivo'} en ${group.name}. 🔄${adminMessage}`, { message_thread_id: threadId, parse_mode: 'Markdown' });
      autoDeleteMessage(chatId, message.message_id, threadId);
      return;
    }

    const confirmButtons = [
      [{ text: '✅ Confirmar', callback_data: `confirm_${action}` }],
      [{ text: '❌ Cancelar', callback_data: `cancel_${groupId}` }]
    ];

    const message = await bot.sendMessage(chatId, `⚠️ ${userMention}, ¿estás seguro de ${isActivation ? 'activar' : 'desactivar'} el bot en ${group.name}? 🤔${adminMessage}`, {
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
    const message = await bot.sendMessage(chatId, `${isActivation ? '🟢' : '🔴'} ${userMention}, el bot ha sido ${isActivation ? 'activado' : 'desactivado'} en ${group.name}. 🎉${adminMessage}`, {
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

    const message = await bot.sendMessage(chatId, `ℹ️ ${userMention}, acción cancelada para ${group.name}. 🔄${adminMessage}`, {
      parse_mode: 'Markdown',
      message_thread_id: threadId
    });
    autoDeleteMessage(chatId, message.message_id, threadId);
    await bot.answerCallbackQuery(query.id);
    return;
  }

  // Manejo de restaurar backup
  if (action === 'restore_backup') {
    if (backups[userId]) {
      userHistory[userId] = backups[userId];
      delete backups[userId];
      const message = await bot.sendMessage(chatId, `💾 ${userMention}, tu historial ha sido restaurado con éxito. 🎉${adminMessage}`, {
        parse_mode: 'Markdown',
        message_thread_id: threadId
      });
      autoDeleteMessage(chatId, message.message_id, threadId);
    } else {
      const message = await bot.sendMessage(chatId, `❌ ${userMention}, no tienes un backup para restaurar. 💾${adminMessage}`, {
        parse_mode: 'Markdown',
        message_thread_id: threadId
      });
      autoDeleteMessage(chatId, message.message_id, threadId);
    }
    await bot.answerCallbackQuery(query.id);
    return;
  }

  // Verificar si el grupo está activo antes de procesar otras acciones
  if (!isAllowedContext(chatId, threadId)) return;

  // Registrar el comando en el historial
  if (!commandHistory[userId]) commandHistory[userId] = [];

  // Otras acciones de botones
  try {
    if (action === 'check') {
      const response = `🔎 ${userMention}, envía un enlace IPTV para verificar (M3U, Xtream, TS, etc.): 📡${adminMessage}`;
      const message = await bot.sendMessage(chatId, response, { message_thread_id: threadId, parse_mode: 'Markdown', reply_to_message_id: messageId });
      commandHistory[userId].push({ command: 'check', response });
      autoDeleteMessage(chatId, message.message_id, threadId);
    } else if (action === 'mirrors') {
      const response = `🪞 ${userMention}, envía un enlace con /espejos para buscar servidores alternativos: 🪞${adminMessage}`;
      const message = await bot.sendMessage(chatId, response, { message_thread_id: threadId, parse_mode: 'Markdown', reply_to_message_id: messageId });
      commandHistory[userId].push({ command: 'mirrors', response });
      autoDeleteMessage(chatId, message.message_id, threadId);
    } else if (action === 'history') {
      if (!userHistory[userId] || userHistory[userId].length === 0) {
        const response = `📑 ${userMention}, tu historial está vacío. Verifica una lista primero. 🔍${adminMessage}`;
        const message = await bot.sendMessage(chatId, response, { message_thread_id: threadId, parse_mode: 'Markdown', reply_to_message_id: messageId, ...mainMenu });
        commandHistory[userId].push({ command: 'history', response });
        autoDeleteMessage(chatId, message.message_id, threadId);
      } else {
        const history = userHistory[userId].slice(-5).map(h => `📡 ${escapeMarkdown(h.url)}\n${h.result.status === 'Active' || h.result.status === 'Activa' ? '✅' : '❌'} ${h.result.status}\n⏳ ${h.timestamp.toLocaleString('es-ES')}`).join('\n\n');
        const response = `📑 ${userMention}, aquí tienes tus últimas 5 verificaciones:\n\n${history}${adminMessage}`;
        const message = await bot.sendMessage(chatId, response, { parse_mode: 'Markdown', message_thread_id: threadId, reply_to_message_id: messageId, ...mainMenu, ...addNavigationButtons(userId, commandHistory[userId].length - 1) });
        commandHistory[userId].push({ command: 'history', response });
        autoDeleteMessage(chatId, message.message_id, threadId);
      }
    } else if (action === 'alert') {
      const response = `⏱ ${userMention}, envía un enlace IPTV seguido de los días para la alerta:\nEjemplo: http://server.com/get.php?username=xxx&password=yyy 3 ⏰${adminMessage}`;
      const message = await bot.sendMessage(chatId, response, { message_thread_id: threadId, parse_mode: 'Markdown', reply_to_message_id: messageId });
      commandHistory[userId].push({ command: 'alert', response });
      autoDeleteMessage(chatId, message.message_id, threadId);
    } else if (action === 'scan') {
      const response = `📊 ${userMention}, envía un enlace IPTV para escanear (M3U o Xtream): 🔎${adminMessage}`;
      const message = await bot.sendMessage(chatId, response, { message_thread_id: threadId, parse_mode: 'Markdown', reply_to_message_id: messageId });
      commandHistory[userId].push({ command: 'scan', response });
      autoDeleteMessage(chatId, message.message_id, threadId);
    } else if (action === 'speedtest') {
      const response = `⚡ ${userMention}, envía un enlace IPTV para realizar una prueba de velocidad: 🚀${adminMessage}`;
      const message = await bot.sendMessage(chatId, response, { message_thread_id: threadId, parse_mode: 'Markdown', reply_to_message_id: messageId });
      commandHistory[userId].push({ command: 'speedtest', response });
      autoDeleteMessage(chatId, message.message_id, threadId);
    } else if (action === 'compare') {
      const response = `🆚 ${userMention}, envía dos enlaces IPTV para comparar (separados por espacio):\nEjemplo: http://server1.com http://server2.com ⚖️${adminMessage}`;
      const message = await bot.sendMessage(chatId, response, { message_thread_id: threadId, parse_mode: 'Markdown', reply_to_message_id: messageId });
      commandHistory[userId].push({ command: 'compare', response });
      autoDeleteMessage(chatId, message.message_id, threadId);
    } else if (action === 'backup') {
      if (!userHistory[userId] || userHistory[userId].length === 0) {
        const response = `❌ ${userMention}, no tienes historial para hacer backup. 📜${adminMessage}`;
        const message = await bot.sendMessage(chatId, response, { message_thread_id: threadId, parse_mode: 'Markdown', reply_to_message_id: messageId, ...mainMenu });
        commandHistory[userId].push({ command: 'backup', response });
        autoDeleteMessage(chatId, message.message_id, threadId);
      } else {
        backups[userId] = userHistory[userId];
        const backupMessage = `💾 ${userMention}, tu historial ha sido guardado. Puedes restaurarlo cuando quieras.\n\n` +
          `📜 *Últimas verificaciones guardadas*:\n${userHistory[userId].slice(-3).map(h => `- ${escapeMarkdown(h.url)} (${h.result.status})`).join('\n')}\n\n` +
          `🔄 Usa el botón para restaurar tu historial en cualquier momento.`;
        const privateMessage = await bot.sendMessage(userId, backupMessage, {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: '🔄 Restaurar Historial', callback_data: 'restore_backup' }]] }
        });
        const response = `💾 ${userMention}, tu historial ha sido guardado. Revisa tus mensajes privados para restaurarlo. 📩${adminMessage}`;
        const groupMessage = await bot.sendMessage(chatId, response, { message_thread_id: threadId, parse_mode: 'Markdown', reply_to_message_id: messageId, ...mainMenu, ...addNavigationButtons(userId, commandHistory[userId].length - 1) });
        commandHistory[userId].push({ command: 'backup', response });
        autoDeleteMessage(chatId, groupMessage.message_id, threadId);
      }
    } else if (action === 'help') {
      const response = `ℹ️ ${userMention}, aquí tienes la ayuda de *${botName}* ℹ️\n\n- Envía un enlace IPTV para verificarlo.\n- Usa /iptv para el menú.\n- Gratis y sin límites.\n- Usa /guia para más detalles. 📖${adminMessage}`;
      const message = await bot.sendMessage(chatId, response, { parse_mode: 'Markdown', message_thread_id: threadId, reply_to_message_id: messageId, ...mainMenu, ...addNavigationButtons(userId, commandHistory[userId].length - 1) });
      commandHistory[userId].push({ command: 'help', response });
      autoDeleteMessage(chatId, message.message_id, threadId);
    } else if (action === 'stats') {
      const response = `📊 *Estadísticas de ${botName}* para ${userMention} 📊\n\n` +
        `🔍 *Verificaciones totales*: ${stats.totalChecks}\n` +
        `👥 *Usuarios únicos*: ${stats.uniqueUsers.size}\n` +
        `⏱ *Alertas activas*: ${stats.activeAlerts}\n\n` +
        `🚀 *Potenciado por ${botName} - 100% Gratis*${adminMessage}`;
      const message = await bot.sendMessage(chatId, response, { parse_mode: 'Markdown', message_thread_id: threadId, reply_to_message_id: messageId, ...mainMenu, ...addNavigationButtons(userId, commandHistory[userId].length - 1) });
      commandHistory[userId].push({ command: 'stats', response });
      autoDeleteMessage(chatId, message.message_id, threadId);
    } else if (action === 'logs') {
      const response = `📜 *Logs de Render* 📜\n\n\`\`\`\n${renderLogs}\n\`\`\`\n\n🚀 *Potenciado por ${botName} - 100% Gratis*${adminMessage}`;
      const message = await bot.sendMessage(chatId, response, { parse_mode: 'Markdown', message_thread_id: threadId, reply_to_message_id: messageId, ...mainMenu, ...addNavigationButtons(userId, commandHistory[userId].length - 1) });
      commandHistory[userId].push({ command: '/logs', response });
      autoDeleteMessage(chatId, message.message_id, threadId);
    } else if (action === 'clear') {
      if (userHistory[userId]) {
        delete userHistory[userId];
        const response = `🗑 ${userMention}, tu historial de verificaciones ha sido limpiado. 🧹${adminMessage}`;
        const message = await bot.sendMessage(chatId, response, { parse_mode: 'Markdown', message_thread_id: threadId, reply_to_message_id: messageId, ...mainMenu, ...addNavigationButtons(userId, commandHistory[userId].length - 1) });
        commandHistory[userId].push({ command: 'clear', response });
        autoDeleteMessage(chatId, message.message_id, threadId);
      } else {
        const response = `🗑 ${userMention}, no tienes historial para limpiar. 📜${adminMessage}`;
        const message = await bot.sendMessage(chatId, response, { parse_mode: 'Markdown', message_thread_id: threadId, reply_to_message_id: messageId, ...mainMenu, ...addNavigationButtons(userId, commandHistory[userId].length - 1) });
        commandHistory[userId].push({ command: 'clear', response });
        autoDeleteMessage(chatId, message.message_id, threadId);
      }
    }
    await bot.answerCallbackQuery(query.id);
  } catch (error) {
    logAction('callback_error', { action, error: error.message });
    const message = await bot.sendMessage(chatId, `❌ ${userMention}, ocurrió un error: ${error.message} ⚠️${adminMessage}`, { message_thread_id: threadId, parse_mode: 'Markdown', reply_to_message_id: messageId });
    autoDeleteMessage(chatId, message.message_id, threadId);
  }
});

// Comando /iptv
bot.onText(/\/iptv/, async (msg) => {
  const chatId = msg.chat.id;
  const threadId = msg.message_thread_id || '0';
  const userId = msg.from.id;
  const userMention = getUserMention(msg.from);

  if (!isAllowedContext(chatId, threadId)) {
    const group = getGroup(chatId);
    if (group && !group.active) {
      const message = await bot.sendMessage(chatId, `🚫 ${userMention}, el bot está desactivado en este grupo. Usa /on para activarlo. 🔄${adminMessage}`, { message_thread_id: threadId, parse_mode: 'Markdown' });
      autoDeleteMessage(chatId, message.message_id, threadId);
    }
    return;
  }

  const response = `🌟 ¡Bienvenido ${userMention} a *${botName}*! 🌟\n\nSoy un bot gratuito para verificar y gestionar listas IPTV. Usa los botones o envía un enlace directamente.\n\n*Comandos disponibles*:\n/iptv - Iniciar\n/guia - Ayuda\n/espejos - Buscar servidores alternativos\n/scan - Escanear lista\n/speedtest - Prueba de velocidad\n/compare - Comparar listas\n/backup - Guardar historial\n/stats - Ver estadísticas\n/limpiar - Borrar historial\n/logs - Ver logs de render\n/on - Activar bot\n/off - Desactivar bot${adminMessage}`;
  const message = await bot.sendMessage(chatId, response, {
    parse_mode: 'Markdown',
    message_thread_id: threadId,
    ...mainMenu,
    ...addNavigationButtons(userId, commandHistory[userId]?.length - 1 || 0)
  });

  if (!commandHistory[userId]) commandHistory[userId] = [];
  commandHistory[userId].push({ command: '/iptv', response });

  autoDeleteMessage(chatId, message.message_id, threadId);
});

// Comando /guia
bot.onText(/\/guia/, async (msg) => {
  const chatId = msg.chat.id;
  const threadId = msg.message_thread_id || '0';
  const userId = msg.from.id;
  const userMention = getUserMention(msg.from);

  if (!isAllowedContext(chatId, threadId)) return;

  const helpMessage = `📖 *Guía de ${botName}* para ${userMention} 📖\n\n` +
    `✨ *¿Para qué sirve este bot?*\n` +
    `Soy un bot diseñado para ayudarte a gestionar y verificar listas IPTV de forma gratuita. Puedo analizar el estado de tus listas, buscar servidores alternativos, escanear contenido, medir velocidad, comparar listas y más.\n\n` +
    `🔧 *¿Cómo funciona?*\n` +
    `- Usa /iptv para iniciar y ver el menú.\n` +
    `- Envía un enlace IPTV para verificarlo (o usa el botón 🔎).\n` +
    `- Usa /espejos para buscar servidores alternativos si uno falla.\n` +
    `- Usa /scan para escanear una lista y ver estadísticas detalladas.\n` +
    `- Usa /speedtest para medir la velocidad de un servidor.\n` +
    `- Usa /compare para comparar dos listas IPTV.\n` +
    `- Usa /backup para guardar tu historial.\n` +
    `- Todos los mensajes se eliminan automáticamente después de 5 minutos para mantener el canal limpio.\n\n` +
    `📋 *Tipos de listas compatibles*:\n` +
    `- *Xtream Codes*: Ejemplo: http://server.com/get.php?username=xxx&password=yyy\n` +
    `- *M3U/M3U8*: Ejemplo: http://server.com/playlist.m3u\n` +
    `- *Enlaces directos (TS/HLS)*: Ejemplo: http://server.com/stream.ts\n` +
    `- *Genérico*: Cualquier URL que pueda verificarse.\n\n` +
    `📜 *Comandos disponibles*:\n` +
    `/iptv - Iniciar el bot\n` +
    `/guia - Ver esta guía\n` +
    `/espejos <servidor> - Buscar servidores alternativos\n` +
    `/scan <url> - Escanear una lista\n` +
    `/speedtest <url> - Medir velocidad del servidor\n` +
    `/compare <url1> <url2> - Comparar dos listas\n` +
    `/backup - Guardar tu historial\n` +
    `/stats - Ver estadísticas del bot\n` +
    `/limpiar - Borrar tu historial\n` +
    `/logs - Ver logs de render\n` +
    `/on - Activar el bot en un grupo\n` +
    `/off - Desactivar el bot en un grupo\n\n` +
    `💡 *Ejemplo de uso*:\n` +
    `- Verificar: http://server.com/get.php?username=xxx&password=yyy\n` +
    `- Buscar espejos: /espejos http://srdigital.win:8080\n` +
    `- Escanear: /scan http://server.com/playlist.m3u\n` +
    `- Comparar: /compare http://server1.com http://server2.com\n` +
    `¡Explora y disfruta de un servicio 100% gratis! 🎉${adminMessage}`;

  const message = await bot.sendMessage(chatId, helpMessage, {
    parse_mode: 'Markdown',
    message_thread_id: threadId,
    ...mainMenu,
    ...addNavigationButtons(userId, commandHistory[userId]?.length - 1 || 0)
  });

  if (!commandHistory[userId]) commandHistory[userId] = [];
  commandHistory[userId].push({ command: '/guia', response: helpMessage });

  // No se autoelimina para que la guía permanezca visible
});

// Comando /espejos (mejorado con estados y búsqueda externa)
bot.onText(/\/espejos\s+(.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const threadId = msg.message_thread_id || '0';
  const userId = msg.from.id;
  const userMention = getUserMention(msg.from);
  const server = match[1].trim();

  if (!isAllowedContext(chatId, threadId)) return;

  // Verificar si el servidor ya tiene un error conocido en los logs
  let logError = '';
  if (renderLogs.includes(server) && renderLogs.includes('free_iptv_error')) {
    logError = `\n⚠️ *Nota*: Este servidor (${escapeMarkdown(server)}) falló previamente con un error 404 según los logs de render.`;
  }

  const checkingMessage = await bot.sendMessage(chatId, `🪞 ${userMention}, buscando servidores espejo para ${escapeMarkdown(server)}... 🔍${adminMessage}${logError}`, {
    parse_mode: 'Markdown',
    message_thread_id: threadId
  });
  autoDeleteMessage(chatId, checkingMessage.message_id, threadId);

  // Mostrar animación de carga
  await showLoadingAnimation(chatId, threadId, checkingMessage.message_id, `🪞 ${userMention}, buscando servidores espejo para ${escapeMarkdown(server)}...`, 4000);

  // Actualizar estado: Buscando en FastoTV
  await bot.editMessageText(`🪞 ${userMention}, buscando servidores espejo para ${escapeMarkdown(server)}...\n📡 *Estado*: Buscando en FastoTV... 🔍${adminMessage}${logError}`, {
    chat_id: chatId,
    message_id: checkingMessage.message_id,
    message_thread_id: threadId,
    parse_mode: 'Markdown'
  });
  const dynamicMirrors = await generateMirrorServers(server);

  // Actualizar estado: Buscando en IPTVCat
  await bot.editMessageText(`🪞 ${userMention}, buscando servidores espejo para ${escapeMarkdown(server)}...\n📡 *Estado*: Buscando en IPTVCat... 🔍${adminMessage}${logError}`, {
    chat_id: chatId,
    message_id: checkingMessage.message_id,
    message_thread_id: threadId,
    parse_mode: 'Markdown'
  });
  const iptvCatMirrors = await searchMirrorsFromIPTVCat(server);

  // Actualizar estado: Buscando en Free-IPTV
  await bot.editMessageText(`🪞 ${userMention}, buscando servidores espejo para ${escapeMarkdown(server)}...\n📡 *Estado*: Buscando en Free-IPTV... 🔍${adminMessage}${logError}`, {
    chat_id: chatId,
    message_id: checkingMessage.message_id,
    message_thread_id: threadId,
    parse_mode: 'Markdown'
  });
  const freeIPTVMirrors = await searchMirrorsFromFreeIPTV(server);

  // Actualizar estado: Buscando en IPTV-Org
  await bot.editMessageText(`🪞 ${userMention}, buscando servidores espejo para ${escapeMarkdown(server)}...\n📡 *Estado*: Buscando en IPTV-Org... 🔍${adminMessage}${logError}`, {
    chat_id: chatId,
    message_id: checkingMessage.message_id,
    message_thread_id: threadId,
    parse_mode: 'Markdown'
  });
  const iptvOrgMirrors = await searchMirrorsFromIPTVOrg(server);

  // Actualizar estado: Buscando en sitios externos
  await bot.editMessageText(`🪞 ${userMention}, buscando servidores espejo para ${escapeMarkdown(server)}...\n📡 *Estado*: Buscando en sitios externos... 🔍${adminMessage}${logError}`, {
    chat_id: chatId,
    message_id: checkingMessage.message_id,
    message_thread_id: threadId,
    parse_mode: 'Markdown'
  });
  const externalResults = await searchMirrorsInExternalSites(server);

  // Combinar resultados y eliminar duplicados
  const mirrors = [...new Set([...dynamicMirrors, ...iptvCatMirrors, ...freeIPTVMirrors, ...iptvOrgMirrors])];

  // Si no se encuentran espejos, usar la base de datos estática
  if (mirrors.length === 0) {
    mirrors.push(...(mirrorsDB[server] || []));
  }

  let response;
  if (mirrors.length > 0) {
    response = `✅ ${userMention}, aquí tienes los servidores espejo para ${escapeMarkdown(server)}:\n\n` +
      mirrors.map(m => `- ${escapeMarkdown(m)}`).join('\n') + `\n\n📡 *Fuentes*: FastoTV, IPTVCat, Free-IPTV, IPTV-Org\n` +
      `🌐 *Resultados de sitios externos*:\n${externalResults.join('\n')}${adminMessage}${logError}`;
  } else {
    response = `❌ ${userMention}, no se encontraron servidores espejo para ${escapeMarkdown(server)}.\n` +
      `🌐 *Resultados de sitios externos*:\n${externalResults.join('\n')}\n` +
      `💡 Intenta con otro servidor o contacta al soporte. 📩${adminMessage}${logError}`;
  }

  await bot.editMessageText(response, {
    chat_id: chatId,
    message_id: checkingMessage.message_id,
    message_thread_id: threadId,
    parse_mode: 'Markdown',
    ...addNavigationButtons(userId, commandHistory[userId]?.length - 1 || 0)
  });

  if (!commandHistory[userId]) commandHistory[userId] = [];
  commandHistory[userId].push({ command: `/espejos ${server}`, response });
});

// Comando /scan
bot.onText(/\/scan\s+(.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const threadId = msg.message_thread_id || '0';
  const userId = msg.from.id;
  const userMention = getUserMention(msg.from);
  const url = match[1].trim();

  if (!isAllowedContext(chatId, threadId)) return;

  const scanningMessage = await bot.sendMessage(chatId, `📊 ${userMention}, escaneando la lista ${escapeMarkdown(url)}... 🔎${adminMessage}`, {
    parse_mode: 'Markdown',
    message_thread_id: threadId
  });
  autoDeleteMessage(chatId, scanningMessage.message_id, threadId);

  await showLoadingAnimation(chatId, threadId, scanningMessage.message_id, `📊 ${userMention}, escaneando la lista ${escapeMarkdown(url)}...`, 2000);

  const result = await scanIPTVList(url);

  if (result.error) {
    const response = `❌ ${userMention}, ocurrió un error al escanear: ${result.error} ⚠️${adminMessage}`;
    await bot.editMessageText(response, {
      chat_id: chatId,
      message_id: scanningMessage.message_id,
      message_thread_id: threadId,
      parse_mode: 'Markdown',
      ...addNavigationButtons(userId, commandHistory[userId]?.length - 1 || 0)
    });
    if (!commandHistory[userId]) commandHistory[userId] = [];
    commandHistory[userId].push({ command: `/scan ${url}`, response });
    return;
  }

  const topCategories = Object.entries(result.categories)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([category, count]) => `${category}: ${count}`);

  const response = `✅ *Resultado del escaneo para ${userMention}* 📊\n\n` +
    `📡 *Lista*: ${escapeMarkdown(url)}\n` +
    `✅ *Canales activos*: ${result.activeChannels}\n` +
    `❌ *Canales inactivos*: ${result.inactiveChannels}\n` +
    `📺 *Total de canales*: ${result.totalChannels}\n` +
    `🎬 *Total de películas*: ${result.totalMovies}\n` +
    `📽 *Total de series*: ${result.totalSeries}\n` +
    `🏷 *Categorías principales*:\n${topCategories.length > 0 ? topCategories.join('\n') : 'No disponible'}\n\n` +
    `🚀 *Potenciado por ${botName} - 100% Gratis*${adminMessage}`;

  await bot.editMessageText(response, {
    chat_id: chatId,
    message_id: scanningMessage.message_id,
    message_thread_id: threadId,
    parse_mode: 'Markdown',
    ...addNavigationButtons(userId, commandHistory[userId]?.length - 1 || 0)
  });

  if (!commandHistory[userId]) commandHistory[userId] = [];
  commandHistory[userId].push({ command: `/scan ${url}`, response });
});

// Comando /speedtest
bot.onText(/\/speedtest\s+(.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const threadId = msg.message_thread_id || '0';
  const userId = msg.from.id;
  const userMention = getUserMention(msg.from);
  const url = match[1].trim();

  if (!isAllowedContext(chatId, threadId)) return;

  const testingMessage = await bot.sendMessage(chatId, `⚡ ${userMention}, realizando prueba de velocidad para ${escapeMarkdown(url)}... 🚀${adminMessage}`, {
    parse_mode: 'Markdown',
    message_thread_id: threadId
  });
  autoDeleteMessage(chatId, testingMessage.message_id, threadId);

  await showLoadingAnimation(chatId, threadId, testingMessage.message_id, `⚡ ${userMention}, realizando prueba de velocidad para ${escapeMarkdown(url)}...`, 2000);

  const result = await speedTestIPTV(url);

  if (result.error) {
    const response = `❌ ${userMention}, ocurrió un error: ${result.error} ⚠️${adminMessage}`;
    await bot.editMessageText(response, {
      chat_id: chatId,
      message_id: testingMessage.message_id,
      message_thread_id: threadId,
      parse_mode: 'Markdown',
      ...addNavigationButtons(userId, commandHistory[userId]?.length - 1 || 0)
    });
    if (!commandHistory[userId]) commandHistory[userId] = [];
    commandHistory[userId].push({ command: `/speedtest ${url}`, response });
    return;
  }

  const response = `✅ *Prueba de velocidad para ${userMention}* ⚡\n\n` +
    `📡 *Servidor*: ${escapeMarkdown(url)}\n` +
    `⏱ *Latencia*: ${result.latency}\n` +
    `📥 *Velocidad de descarga*: ${result.downloadSpeed}\n\n` +
    `🚀 *Potenciado por ${botName} - 100% Gratis*${adminMessage}`;

  await bot.editMessageText(response, {
    chat_id: chatId,
    message_id: testingMessage.message_id,
    message_thread_id: threadId,
    parse_mode: 'Markdown',
    ...addNavigationButtons(userId, commandHistory[userId]?.length - 1 || 0)
  });

  if (!commandHistory[userId]) commandHistory[userId] = [];
  commandHistory[userId].push({ command: `/speedtest ${url}`, response });
});

// Comando /compare
bot.onText(/\/compare\s+(.+)\s+(.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const threadId = msg.message_thread_id || '0';
  const userId = msg.from.id;
  const userMention = getUserMention(msg.from);
  const url1 = match[1].trim();
  const url2 = match[2].trim();

  if (!isAllowedContext(chatId, threadId)) return;

  const comparingMessage = await bot.sendMessage(chatId, `🆚 ${userMention}, comparando ${escapeMarkdown(url1)} con ${escapeMarkdown(url2)}... ⚖️${adminMessage}`, {
    parse_mode: 'Markdown',
    message_thread_id: threadId
  });
  autoDeleteMessage(chatId, comparingMessage.message_id, threadId);

  await showLoadingAnimation(chatId, threadId, comparingMessage.message_id, `🆚 ${userMention}, comparando ${escapeMarkdown(url1)} con ${escapeMarkdown(url2)}...`, 2000);

  const [result1, result2] = await Promise.all([
    checkIPTVList(url1),
    checkIPTVList(url2)
  ]);

  const response = `✅ *Comparación de listas para ${userMention}* 🆚\n\n` +
    `📡 *Lista 1*: ${escapeMarkdown(url1)}\n` +
    `📜 *Tipo*: ${result1.type}\n` +
    `${result1.status === 'Active' || result1.status === 'Activa' ? '✅' : '❌'} *Estado*: ${result1.status}\n` +
    `📺 *Canales*: ${result1.totalChannels || 0}\n` +
    `🎬 *Películas*: ${result1.totalMovies || 0}\n` +
    `📽 *Series*: ${result1.totalSeries || 0}\n` +
    `${result1.error ? `⚠️ *Error*: ${result1.error}\n` : ''}\n` +
    `📡 *Lista 2*: ${escapeMarkdown(url2)}\n` +
    `📜 *Tipo*: ${result2.type}\n` +
    `${result2.status === 'Active' || result2.status === 'Activa' ? '✅' : '❌'} *Estado*: ${result2.status}\n` +
    `📺 *Canales*: ${result2.totalChannels || 0}\n` +
    `🎬 *Películas*: ${result2.totalMovies || 0}\n` +
    `📽 *Series*: ${result2.totalSeries || 0}\n` +
    `${result2.error ? `⚠️ *Error*: ${result2.error}\n` : ''}\n\n` +
    `🚀 *Potenciado por ${botName} - 100% Gratis*${adminMessage}`;

  await bot.editMessageText(response, {
    chat_id: chatId,
    message_id: comparingMessage.message_id,
    message_thread_id: threadId,
    parse_mode: 'Markdown',
    ...addNavigationButtons(userId, commandHistory[userId]?.length - 1 || 0)
  });

  if (!commandHistory[userId]) commandHistory[userId] = [];
  commandHistory[userId].push({ command: `/compare ${url1} ${url2}`, response });
});

// Comando /backup
bot.onText(/\/backup/, async (msg) => {
  const chatId = msg.chat.id;
  const threadId = msg.message_thread_id || '0';
  const userId = msg.from.id;
  const userMention = getUserMention(msg.from);

  if (!isAllowedContext(chatId, threadId)) return;

  if (!userHistory[userId] || userHistory[userId].length === 0) {
    const response = `❌ ${userMention}, no tienes historial para hacer backup. 📜${adminMessage}`;
    const message = await bot.sendMessage(chatId, response, { message_thread_id: threadId, parse_mode: 'Markdown', ...mainMenu, ...addNavigationButtons(userId, commandHistory[userId]?.length - 1 || 0) });
    if (!commandHistory[userId]) commandHistory[userId] = [];
    commandHistory[userId].push({ command: '/backup', response });
    autoDeleteMessage(chatId, message.message_id, threadId);
    return;
  }

  backups[userId] = userHistory[userId];
  const backupMessage = `💾 ${userMention}, tu historial ha sido guardado. Puedes restaurarlo cuando quieras.\n\n` +
    `📜 *Últimas verificaciones guardadas*:\n${userHistory[userId].slice(-3).map(h => `- ${escapeMarkdown(h.url)} (${h.result.status})`).join('\n')}\n\n` +
    `🔄 Usa el botón para restaurar tu historial en cualquier momento.`;
  await bot.sendMessage(userId, backupMessage, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[{ text: '🔄 Restaurar Historial', callback_data: 'restore_backup' }]] }
  });

  const response = `💾 ${userMention}, tu historial ha sido guardado. Revisa tus mensajes privados para restaurarlo. 📩${adminMessage}`;
  const message = await bot.sendMessage(chatId, response, { message_thread_id: threadId, parse_mode: 'Markdown', ...mainMenu, ...addNavigationButtons(userId, commandHistory[userId]?.length - 1 || 0) });
  if (!commandHistory[userId]) commandHistory[userId] = [];
  commandHistory[userId].push({ command: '/backup', response });
  autoDeleteMessage(chatId, message.message_id, threadId);
});

// Comando /stats
bot.onText(/\/stats/, async (msg) => {
  const chatId = msg.chat.id;
  const threadId = msg.message_thread_id || '0';
  const userId = msg.from.id;
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
    ...mainMenu,
    ...addNavigationButtons(userId, commandHistory[userId]?.length - 1 || 0)
  });

  if (!commandHistory[userId]) commandHistory[userId] = [];
  commandHistory[userId].push({ command: '/stats', response });

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
    const response = `🗑 ${userMention}, tu historial de verificaciones ha sido limpiado. 🧹${adminMessage}`;
    const message = await bot.sendMessage(chatId, response, {
      parse_mode: 'Markdown',
      message_thread_id: threadId,
      ...mainMenu,
      ...addNavigationButtons(userId, commandHistory[userId]?.length - 1 || 0)
    });
    if (!commandHistory[userId]) commandHistory[userId] = [];
    commandHistory[userId].push({ command: '/limpiar', response });
    autoDeleteMessage(chatId, message.message_id, threadId);
  } else {
    const response = `🗑 ${userMention}, no tienes historial para limpiar. 📜${adminMessage}`;
    const message = await bot.sendMessage(chatId, response, {
      parse_mode: 'Markdown',
      message_thread_id: threadId,
      ...mainMenu,
      ...addNavigationButtons(userId, commandHistory[userId]?.length - 1 || 0)
    });
    if (!commandHistory[userId]) commandHistory[userId] = [];
    commandHistory[userId].push({ command: '/limpiar', response });
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

    const isIPTV = text.match(/(http|https):\/\/[^\s]+/) || text.includes('get.php') || text.includes('.m3u') || text.includes('.m3u8') || text.includes('.ts') || text.includes('hls');

    // Configurar alerta
    if (text.match(/(http|https):\/\/[^\s]+\s+\d+/)) {
      const [url, days] = text.split(/\s+/);
      const daysNum = parseInt(days);

      if (isNaN(daysNum) || daysNum < 1) {
        const message = await bot.sendMessage(chatId, `❌ ${userMention}, por favor especifica un número válido de días. Ejemplo: http://server.com 3 ⏰${adminMessage}`, {
          parse_mode: 'Markdown',
          message_thread_id: threadId
        });
        autoDeleteMessage(chatId, message.message_id, threadId);
        return;
      }

      if (!alerts[userId]) alerts[userId] = [];
      alerts[userId].push({ url, days: daysNum, lastChecked: null, chatId, threadId });
      stats.activeAlerts++;
      saveStats();

      const message = await bot.sendMessage(chatId, `⏱ ${userMention}, alerta configurada para ${escapeMarkdown(url)} cada ${daysNum} día(s). Te notificaré cuando cambie su estado. 🔔${adminMessage}`, {
        parse_mode: 'Markdown',
        message_thread_id: threadId,
        ...addNavigationButtons(userId, commandHistory[userId]?.length - 1 || 0)
      });

      if (!commandHistory[userId]) commandHistory[userId] = [];
      commandHistory[userId].push({ command: `Alerta ${url} ${daysNum}`, response: `⏱ ${userMention}, alerta configurada para ${escapeMarkdown(url)} cada ${daysNum} día(s). Te notificaré cuando cambie su estado. 🔔${adminMessage}` });

      autoDeleteMessage(chatId, message.message_id, threadId);
      return;
    }

    // Verificar lista IPTV
    if (isIPTV && !text.startsWith('/')) {
      const url = text.match(/(http|https):\/\/[^\s]+/)?.[0] || text;
      stats.totalChecks++;
      stats.uniqueUsers.add(userId);
      saveStats();

      const checkingMessage = await bot.sendMessage(chatId, `🔎 ${userMention}, verificando la lista ${escapeMarkdown(url)}... 📡${adminMessage}`, {
        parse_mode: 'Markdown',
        message_thread_id: threadId,
        reply_to_message_id: replyToMessage?.message_id
      });
      autoDeleteMessage(chatId, checkingMessage.message_id, threadId);

      await showLoadingAnimation(chatId, threadId, checkingMessage.message_id, `🔎 ${userMention}, verificando la lista ${escapeMarkdown(url)}...`, 2000);

      const result = await checkIPTVList(url);

      if (!userHistory[userId]) userHistory[userId] = [];
      userHistory[userId].push({ url, result, timestamp: new Date() });

      const { text: responseText } = formatResponse(msg, result, replyToMessage?.message_id);

      await bot.editMessageText(responseText, {
        chat_id: chatId,
        message_id: checkingMessage.message_id,
        message_thread_id: threadId,
        parse_mode: 'Markdown',
        reply_to_message_id: replyToMessage?.message_id,
        ...addNavigationButtons(userId, commandHistory[userId]?.length - 1 || 0)
      });

      if (!commandHistory[userId]) commandHistory[userId] = [];
      commandHistory[userId].push({ command: `Verificar ${url}`, response: responseText });
    }
  });

  // Tarea programada para alertas
  cron.schedule('0 0 * * *', async () => {
    const now = new Date();
    for (const userId in alerts) {
      const userAlerts = alerts[userId];
      for (let i = userAlerts.length - 1; i >= 0; i--) {
        const alert = userAlerts[i];
        const { url, days, lastChecked, chatId, threadId } = alert;

        const daysSinceLastCheck = lastChecked ? (now - new Date(lastChecked)) / (1000 * 60 * 60 * 24) : days;
        if (daysSinceLastCheck >= days) {
          const result = await checkIPTVList(url);
          alert.lastChecked = now;

          const userMention = getUserMention({ id: userId, first_name: 'Usuario' });
          const statusChanged = result.status !== alert.lastStatus;
          alert.lastStatus = result.status;

          if (statusChanged) {
            const message = await bot.sendMessage(chatId, `🔔 ${userMention}, la lista ${escapeMarkdown(url)} ha cambiado de estado:\n` +
              `${result.status === 'Active' || result.status === 'Activa' ? '✅' : '❌'} *Estado*: ${result.status}\n` +
              `📡 *Detalles*: ${result.totalChannels || 0} canales, ${result.totalMovies || 0} películas, ${result.totalSeries || 0} series\n` +
              `🚀 *Potenciado por ${botName} - 100% Gratis*${adminMessage}`, {
              parse_mode: 'Markdown',
              message_thread_id: threadId
            });
            autoDeleteMessage(chatId, message.message_id, threadId);
          }
        }
      }
    }
  });

  // Manejo de errores global
  bot.on('polling_error', (error) => {
    logAction('polling_error', { error: error.message });
  });

  bot.on('webhook_error', (error) => {
    logAction('webhook_error', { error: error.message });
  });

  console.log(`🚀 ${botName} iniciado 🎉`);