const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const cron = require('node-cron');
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

// IDs permitidos (simplificado, sin lógica de activación/desactivación)
const ALLOWED_CHAT_IDS = [
  { chatId: '-1002348662107', threadId: '53411', name: 'EntresHijos' },
  { chatId: '-1002565012502', threadId: null, name: 'BotChecker_IPTV_ParaG' }
];

// Almacenar datos
let userHistory = {};
let commandHistory = {}; // Historial de comandos para navegación
let alerts = {};

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

// Registrar logs (solo en consola)
function logAction(action, details) {
  const timestamp = new Date().toLocaleString('es-ES');
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

// Animación de "cargando" con emojis (optimizada para evitar 429)
async function showLoadingAnimation(chatId, threadId, messageId, baseText, duration) {
  const frames = ['🔍', '⏳', '🔎'];
  let frameIndex = 0;
  const interval = 1000; // 1 segundo por frame
  const steps = Math.floor(duration / interval);

  for (let i = 0; i < steps; i++) {
    const frame = frames[frameIndex % frames.length];
    try {
      await bot.editMessageText(`${baseText} ${frame}`, {
        chat_id: chatId,
        message_id: messageId,
        message_thread_id: threadId,
        parse_mode: 'Markdown'
      });
    } catch (error) {
      if (error.response?.status === 429) {
        const retryAfter = error.response.data.parameters.retry_after || 1;
        logAction('rate_limit_error', { retryAfter });
        await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
        continue;
      }
      logAction('loading_animation_error', { chatId, messageId, error: error.message });
      break;
    }
    frameIndex++;
    await new Promise(resolve => setTimeout(resolve, interval));
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
});

// Configurar webhook con reintentos para manejar 429
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
    throw error;
  }
}

// Verificar contexto
function isAllowedContext(chatId, threadId) {
  const group = ALLOWED_CHAT_IDS.find(g => g.chatId === String(chatId));
  if (!group) return false;
  return group.threadId ? String(threadId) === group.threadId : true;
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
    logAction('generate_mirrors_error', { error: error.message });
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

// Consultar iptv-org.github.io para buscar servidores espejo
async function searchMirrorsFromIPTVOrg(serverUrl) {
  try {
    const url = new URL(serverUrl);
    const domain = url.hostname;
    const baseDomain = domain.split('.').slice(-2).join('.');

    const response = await axios.get('https://iptv-org.github.io/iptv/index.m3u', { timeout: 5000 });
    const lines = response.data.split('\n');
    const mirrors = [];

    for (const line of lines) {
      if (line.startsWith('http')) {
        try {
          const mirrorUrl = new URL(line.trim());
          const mirrorDomain = mirrorUrl.hostname;
          if (mirrorDomain.includes(baseDomain) && mirrorUrl.href !== serverUrl) {
            mirrors.push(mirrorUrl.href);
          }
        } catch (error) {
          // Ignorar URLs mal formadas
        }
      }
    }

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
    logAction('iptvorg_error', { error: error.message });
    return [];
  }
}

// Consultar free-iptv.github.io para buscar servidores espejo
async function searchMirrorsFromFreeIPTV(serverUrl) {
  try {
    const url = new URL(serverUrl);
    const domain = url.hostname;
    const baseDomain = domain.split('.').slice(-2).join('.');

    const response = await axios.get('https://free-iptv.github.io/iptv/index.m3u', { timeout: 5000 });
    const lines = response.data.split('\n');
    const mirrors = [];

    for (const line of lines) {
      if (line.startsWith('http')) {
        try {
          const mirrorUrl = new URL(line.trim());
          const mirrorDomain = mirrorUrl.hostname;
          if (mirrorDomain.includes(baseDomain) && mirrorUrl.href !== serverUrl) {
            mirrors.push(mirrorUrl.href);
          }
        } catch (error) {
          // Ignorar URLs mal formadas
        }
      }
    }

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
    logAction('freeiptv_error', { error: error.message });
    return [];
  }
}

// Consultar fluxus.to para buscar servidores espejo
async function searchMirrorsFromFluxus(serverUrl) {
  try {
    const url = new URL(serverUrl);
    const domain = url.hostname;
    const baseDomain = domain.split('.').slice(-2).join('.');

    const response = await axios.get('https://fluxus.to/', { timeout: 5000 });
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
    logAction('fluxus_error', { error: error.message });
    return [];
  }
}

// Consultar iptv-checker.com para buscar servidores espejo
async function searchMirrorsFromIPTVChecker(serverUrl) {
  try {
    const url = new URL(serverUrl);
    const domain = url.hostname;
    const baseDomain = domain.split('.').slice(-2).join('.');

    const response = await axios.get('https://iptv-checker.com/', { timeout: 5000 });
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
    logAction('iptvchecker_error', { error: error.message });
    return [];
  }
}

// Consultar iptv-playlist.com para buscar servidores espejo
async function searchMirrorsFromIPTVPlaylist(serverUrl) {
  try {
    const url = new URL(serverUrl);
    const domain = url.hostname;
    const baseDomain = domain.split('.').slice(-2).join('.');

    const response = await axios.get('https://iptv-playlist.com/', { timeout: 5000 });
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
    logAction('iptvplaylist_error', { error: error.message });
    return [];
  }
}

// Consultar iptvstream.live para buscar servidores espejo
async function searchMirrorsFromIPTVStream(serverUrl) {
  try {
    const url = new URL(serverUrl);
    const domain = url.hostname;
    const baseDomain = domain.split('.').slice(-2).join('.');

    const response = await axios.get('https://iptvstream.live/', { timeout: 5000 });
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
    logAction('iptvstream_error', { error: error.message });
    return [];
  }
}

// Consultar iptv4best.com para buscar servidores espejo
async function searchMirrorsFromIPTV4Best(serverUrl) {
  try {
    const url = new URL(serverUrl);
    const domain = url.hostname;
    const baseDomain = domain.split('.').slice(-2).join('.');

    const response = await axios.get('https://iptv4best.com/', { timeout: 5000 });
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
    logAction('iptv4best_error', { error: error.message });
    return [];
  }
}

// Consultar iptvlinksfree.com para buscar servidores espejo
async function searchMirrorsFromIPTVLinks(serverUrl) {
  try {
    const url = new URL(serverUrl);
    const domain = url.hostname;
    const baseDomain = domain.split('.').slice(-2).join('.');

    const response = await axios.get('https://iptvlinksfree.com/', { timeout: 5000 });
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
    logAction('iptvlinks_error', { error: error.message });
    return [];
  }
}

// Consultar iptv.git.github.io para buscar servidores espejo
async function searchMirrorsFromIPTVGit(serverUrl) {
  try {
    const url = new URL(serverUrl);
    const domain = url.hostname;
    const baseDomain = domain.split('.').slice(-2).join('.');

    const response = await axios.get('https://iptv.git.github.io/index.m3u', { timeout: 5000 });
    const lines = response.data.split('\n');
    const mirrors = [];

    for (const line of lines) {
      if (line.startsWith('http')) {
        try {
          const mirrorUrl = new URL(line.trim());
          const mirrorDomain = mirrorUrl.hostname;
          if (mirrorDomain.includes(baseDomain) && mirrorUrl.href !== serverUrl) {
            mirrors.push(mirrorUrl.href);
          }
        } catch (error) {
          // Ignorar URLs mal formadas
        }
      }
    }

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
    logAction('iptvgit_error', { error: error.message });
    return [];
  }
}

// Consultar iptv.community para buscar servidores espejo
async function searchMirrorsFromIPTVCommunity(serverUrl) {
  try {
    const url = new URL(serverUrl);
    const domain = url.hostname;
    const baseDomain = domain.split('.').slice(-2).join('.');

    const response = await axios.get('https://iptv.community/', { timeout: 5000 });
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
    logAction('iptvcommunity_error', { error: error.message });
    return [];
  }
}

// Consultar iptvonline.me para buscar servidores espejo
async function searchMirrorsFromIPTVOnline(serverUrl) {
  try {
    const url = new URL(serverUrl);
    const domain = url.hostname;
    const baseDomain = domain.split('.').slice(-2).join('.');

    const response = await axios.get('https://iptvonline.me/', { timeout: 5000 });
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
    logAction('iptvonline_error', { error: error.message });
    return [];
  }
}

// Consultar iptvstreamz.com para buscar servidores espejo
async function searchMirrorsFromIPTVStreamz(serverUrl) {
  try {
    const url = new URL(serverUrl);
    const domain = url.hostname;
    const baseDomain = domain.split('.').slice(-2).join('.');

    const response = await axios.get('https://iptvstreamz.com/', { timeout: 5000 });
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
    logAction('iptvstreamz_error', { error: error.message });
    return [];
  }
}

// Consultar iptvlists.com para buscar servidores espejo
async function searchMirrorsFromIPTVLists(serverUrl) {
  try {
    const url = new URL(serverUrl);
    const domain = url.hostname;
    const baseDomain = domain.split('.').slice(-2).join('.');

    const response = await axios.get('https://iptvlists.com/', { timeout: 5000 });
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
    logAction('iptvlists_error', { error: error.message });
    return [];
  }
}

// Consultar iptvworld.net para buscar servidores espejo
async function searchMirrorsFromIPTVWorld(serverUrl) {
  try {
    const url = new URL(serverUrl);
    const domain = url.hostname;
    const baseDomain = domain.split('.').slice(-2).join('.');

    const response = await axios.get('https://iptvworld.net/', { timeout: 5000 });
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
    logAction('iptvworld_error', { error: error.message });
    return [];
  }
}

// Consultar iptvstreamers.com para buscar servidores espejo
async function searchMirrorsFromIPTVStreamers(serverUrl) {
  try {
    const url = new URL(serverUrl);
    const domain = url.hostname;
    const baseDomain = domain.split('.').slice(-2).join('.');

    const response = await axios.get('https://iptvstreamers.com/', { timeout: 5000 });
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
    logAction('iptvstreamers_error', { error: error.message });
    return [];
  }
}

// Verificar lista IPTV
async function checkIPTVList(url) {
  logAction('check_start', { url });
  try {
    url = url.trim();
    if (!url.startsWith('http')) url = `http://${url}`;

    // 1. Xtream Codes
    if (url.includes('get.php')) {
      const [, params] = url.split('?');
      const queryParams = Object.fromEntries(new URLSearchParams(params));
      const { username, password } = queryParams;
      const server = url.split('/get.php')[0];
      const apiUrl = `${server}/player_api.php?username=${username}&password=${password}`;

      const response = await axios.get(apiUrl, { timeout: 3000 });
      const { user_info, server_info } = response.data;
      const streams = await axios.get(`${apiUrl}&action=get_live_streams`, { timeout: 3000 });

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
        totalChannels: streams.data.length,
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
        totalChannels: lines.filter(line => line.startsWith('#EXTINF')).length,
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
        totalChannels: 1,
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
      totalChannels: 1,
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
    `${result.timezone ? `⏲ *Zona horaria*: ${result.timezone}\n` : ''}` +
    `${result.error ? `⚠️ *Error*: ${escapeMarkdown(result.error)}\n` : ''}` +
    `${result.error ? `💡 *Sugerencia*: Prueba con /espejos ${escapeMarkdown(result.server)} para buscar servidores alternativos.\n` : ''}\n` +
    `📺 *Canales (muestra)*: ${result.channels?.length > 0 ? result.channels.map(c => escapeMarkdown(c)).join(' 🌐 ') : 'No disponible'}\n` +
    `${result.channels?.length < result.totalChannels ? `*(+${result.totalChannels - result.channels.length} más)*` : ''}\n\n` +
    `🚀 *Potenciado por ${botName} - 100% Gratis*${adminMessage}`;

  return { text: response, replyTo: previousMessageId };
}

// Menú principal (sin botones de /stats, /limpiar, /logs, /on, /off)
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
        { text: 'ℹ️ Ayuda', callback_data: 'help' }
      ]
    ]
  }
};

// Función para añadir botones de navegación
function addNavigationButtons(userId, currentIndex) {
  if (!commandHistory[userId] || commandHistory[userId].length <= 1) return {};
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

// Manejo de botones
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const threadId = query.message.message_thread_id || '0';
  const userId = query.from.id;
  const messageId = query.message.message_id;
  const userMention = getUserMention(query.from);

  const action = query.data;

  // Responder a la callback query lo más rápido posible
  try {
    await bot.answerCallbackQuery(query.id);
  } catch (error) {
    logAction('answer_callback_error', { queryId: query.id, error: error.message });
  }

  // Manejo de navegación
  if (action.startsWith('navigate_prev_') || action.startsWith('navigate_next_')) {
    const direction = action.startsWith('navigate_prev_') ? 'prev' : 'next';
    let currentIndex = parseInt(action.split('_').pop());

    if (!commandHistory[userId] || commandHistory[userId].length === 0) {
      const message = await bot.sendMessage(chatId, `❌ ${userMention}, no hay historial de comandos para navegar. 📜${adminMessage}`, {
        message_thread_id: threadId,
        parse_mode: 'Markdown'
      });
      autoDeleteMessage(chatId, message.message_id, threadId);
      return;
    }

    if (direction === 'prev' && currentIndex > 0) {
      currentIndex--;
    } else if (direction === 'next' && currentIndex < commandHistory[userId].length - 1) {
      currentIndex++;
    } else {
      return;
    }

    const commandEntry = commandHistory[userId][currentIndex];
    if (!commandEntry) {
      const message = await bot.sendMessage(chatId, `❌ ${userMention}, entrada de historial no encontrada. 📜${adminMessage}`, {
        message_thread_id: threadId,
        parse_mode: 'Markdown'
      });
      autoDeleteMessage(chatId, message.message_id, threadId);
      return;
    }

    let responseText = commandEntry.response;

    const currentMessageText = query.message.text || '';
    const currentMarkup = query.message.reply_markup || {};
    const newMarkup = addNavigationButtons(userId, currentIndex).reply_markup || {};

    if (currentMessageText === responseText && JSON.stringify(currentMarkup) === JSON.stringify(newMarkup)) {
      return;
    }

    try {
      await bot.editMessageText(responseText, {
        chat_id: chatId,
        message_id: messageId,
        message_thread_id: threadId,
        parse_mode: 'Markdown',
        ...addNavigationButtons(userId, currentIndex)
      });
    } catch (error) {
      if (error.response?.status === 429) {
        const retryAfter = error.response.data.parameters.retry_after || 1;
        logAction('rate_limit_error', { retryAfter });
        await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
        await bot.editMessageText(responseText, {
          chat_id: chatId,
          message_id: messageId,
          message_thread_id: threadId,
          parse_mode: 'Markdown',
          ...addNavigationButtons(userId, currentIndex)
        });
        return;
      }
      logAction('edit_message_error', { chatId, messageId, error: error.message });
      const message = await bot.sendMessage(chatId, `❌ ${userMention}, error al navegar: ${error.message} ⚠️${adminMessage}`, {
        message_thread_id: threadId,
        parse_mode: 'Markdown'
      });
      autoDeleteMessage(chatId, message.message_id, threadId);
    }
    return;
  }

  if (!isAllowedContext(chatId, threadId)) return;

  if (!commandHistory[userId]) commandHistory[userId] = [];

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
    } else if (action === 'help') {
      const response = `ℹ️ ${userMention}, aquí tienes la ayuda de *${botName}* ℹ️\n\n- Envía un enlace IPTV para verificarlo.\n- Usa /iptv para el menú.\n- Gratis y sin límites.\n- Usa /guia para más detalles. 📖${adminMessage}`;
      const message = await bot.sendMessage(chatId, response, { parse_mode: 'Markdown', message_thread_id: threadId, reply_to_message_id: messageId, ...mainMenu, ...addNavigationButtons(userId, commandHistory[userId].length - 1) });
      commandHistory[userId].push({ command: 'help', response });
      autoDeleteMessage(chatId, message.message_id, threadId);
    }
  } catch (error) {
    if (error.response?.status === 429) {
      const retryAfter = error.response.data.parameters.retry_after || 1;
      logAction('rate_limit_error', { retryAfter });
      await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
      return;
    }
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

  if (!isAllowedContext(chatId, threadId)) return;

  const response = `🌟 ¡Bienvenido ${userMention} a *${botName}*! 🌟\n\nSoy un bot gratuito para verificar y gestionar listas IPTV. Usa los botones o envía un enlace directamente.\n\n*Comandos disponibles*:\n/iptv - Iniciar\n/guia - Ayuda\n/espejos - Buscar servidores alternativos${adminMessage}`;
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
    `Soy un bot diseñado para ayudarte a gestionar y verificar listas IPTV de forma gratuita. Puedo analizar el estado de tus listas y buscar servidores alternativos.\n\n` +
    `🔧 *¿Cómo funciona?*\n` +
    `- Usa /iptv para iniciar y ver el menú.\n` +
    `- Envía un enlace IPTV para verificarlo (o usa el botón 🔎).\n` +
    `- Usa /espejos para buscar servidores alternativos si uno falla.\n` +
    `- Todos los mensajes se eliminan automáticamente después de 5 minutos para mantener el canal limpio.\n\n` +
    `📋 *Tipos de listas compatibles*:\n` +
    `- *Xtream Codes*: Ejemplo: http://server.com/get.php?username=xxx&password=yyy\n` +
    `- *M3U/M3U8*: Ejemplo: http://server.com/playlist.m3u\n` +
    `- *Enlaces directos (TS/HLS)*: Ejemplo: http://server.com/stream.ts\n` +
    `- *Genérico*: Cualquier URL que pueda verificarse.\n\n` +
    `📜 *Comandos disponibles*:\n` +
    `/iptv - Iniciar el bot\n` +
    `/guia - Ver esta guía\n` +
    `/espejos <servidor> - Buscar servidores alternativos\n\n` +
    `💡 *Ejemplo de uso*:\n` +
    `- Verificar: http://server.com/get.php?username=xxx&password=yyy\n` +
    `- Buscar espejos: /espejos http://srdigital.win:8080\n` +
    `¡Explora y disfruta de un servicio 100% gratis! 🎉${adminMessage}`;

  const message = await bot.sendMessage(chatId, helpMessage, {
    parse_mode: 'Markdown',
    message_thread_id: threadId,
    ...mainMenu,
    ...addNavigationButtons(userId, commandHistory[userId]?.length - 1 || 0)
  });

  if (!commandHistory[userId]) commandHistory[userId] = [];
  commandHistory[userId].push({ command: '/guia', response: helpMessage });
});

// Comando /espejos (con más fuentes)
bot.onText(/\/espejos\s+(.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const threadId = msg.message_thread_id || '0';
  const userId = msg.from.id;
  const userMention = getUserMention(msg.from);
  const server = match[1].trim();

  if (!isAllowedContext(chatId, threadId)) return;

  const checkingMessage = await bot.sendMessage(chatId, `🪞 ${userMention}, buscando servidores espejo para ${escapeMarkdown(server)}... 🔍${adminMessage}`, {
    parse_mode: 'Markdown',
    message_thread_id: threadId
  });
  autoDeleteMessage(chatId, checkingMessage.message_id, threadId);

  await showLoadingAnimation(chatId, threadId, checkingMessage.message_id, `🪞 ${userMention}, buscando servidores espejo para ${escapeMarkdown(server)}...`, 5000);

  const sources = [
    { name: 'FastoTV', search: generateMirrorServers },
    { name: 'IPTVCat', search: searchMirrorsFromIPTVCat },
    { name: 'IPTV-org', search: searchMirrorsFromIPTVOrg },
    { name: 'Free-IPTV', search: searchMirrorsFromFreeIPTV },
    { name: 'Fluxus', search: searchMirrorsFromFluxus },
    { name: 'IPTV-Checker', search: searchMirrorsFromIPTVChecker },
    { name: 'IPTV-Playlist', search: searchMirrorsFromIPTVPlaylist },
    { name: 'IPTVStream', search: searchMirrorsFromIPTVStream },
    { name: 'IPTV4Best', search: searchMirrorsFromIPTV4Best },
    { name: 'IPTVLinks', search: searchMirrorsFromIPTVLinks },
    { name: 'IPTVGit', search: searchMirrorsFromIPTVGit },
    { name: 'IPTVCommunity', search: searchMirrorsFromIPTVCommunity },
    { name: 'IPTVOnline', search: searchMirrorsFromIPTVOnline },
    { name: 'IPTVStreamz', search: searchMirrorsFromIPTVStreamz },
    { name: 'IPTVLists', search: searchMirrorsFromIPTVLists },
    { name: 'IPTVWorld', search: searchMirrorsFromIPTVWorld },
    { name: 'IPTVStreamers', search: searchMirrorsFromIPTVStreamers }
  ];

  const mirrorsBySource = {};
  for (const source of sources) {
    try {
      await bot.editMessageText(`🪞 ${userMention}, buscando servidores espejo para ${escapeMarkdown(server)}...\n📡 *Estado*: Buscando en ${source.name}... 🔍${adminMessage}`, {
        chat_id: chatId,
        message_id: checkingMessage.message_id,
        message_thread_id: threadId,
        parse_mode: 'Markdown'
      });
      const mirrors = await source.search(server);
      mirrorsBySource[source.name] = mirrors;
    } catch (error) {
      logAction(`${source.name}_error`, { error: error.message });
      mirrorsBySource[source.name] = [];
    }
  }

  // Combinar resultados y eliminar duplicados
  const allMirrors = Object.values(mirrorsBySource).flat();
  const mirrors = [...new Set(allMirrors)];

  // Si no se encuentran espejos, usar la base de datos estática
  if (mirrors.length === 0) {
    mirrors.push(...(mirrorsDB[server] || []));
  }

  let response;
  if (mirrors.length > 0) {
    const sourcesUsed = Object.keys(mirrorsBySource).filter(source => mirrorsBySource[source].length > 0).join(', ');
    response = `✅ ${userMention}, aquí tienes los servidores espejo para ${escapeMarkdown(server)}:\n\n` +
      mirrors.map(m => `- ${escapeMarkdown(m)}`).join('\n') + `\n\n📡 *Fuentes*: ${sourcesUsed || 'Base de datos estática'}\n` +
      `🚀 *Potenciado por ${botName} - 100% Gratis*${adminMessage}`;
  } else {
    response = `❌ ${userMention}, no se encontraron servidores espejo para ${escapeMarkdown(server)}.\n` +
      `💡 Intenta con otro servidor o contacta al soporte. 📩${adminMessage}`;
  }

  try {
    await bot.editMessageText(response, {
      chat_id: chatId,
      message_id: checkingMessage.message_id,
      message_thread_id: threadId,
      parse_mode: 'Markdown',
      ...addNavigationButtons(userId, commandHistory[userId]?.length - 1 || 0)
    });
  } catch (error) {
    if (error.response?.status === 429) {
      const retryAfter = error.response.data.parameters.retry_after || 1;
      logAction('rate_limit_error', { retryAfter });
      await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
      await bot.editMessageText(response, {
        chat_id: chatId,
        message_id: checkingMessage.message_id,
        message_thread_id: threadId,
        parse_mode: 'Markdown',
        ...addNavigationButtons(userId, commandHistory[userId]?.length - 1 || 0)
      });
      return;
    }
    throw error;
  }

  if (!commandHistory[userId]) commandHistory[userId] = [];
  commandHistory[userId].push({ command: `/espejos ${server}`, response });
});

// Procesar mensajes con URLs IPTV o alertas
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const threadId = msg.message_thread_id || '0';
  const userId = msg.from.id;
  const text = msg.text || '';
  const replyToMessage = msg.reply_to_message;
  const userMention = getUserMention(msg.from);

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

    try {
      await bot.editMessageText(responseText, {
        chat_id: chatId,
        message_id: checkingMessage.message_id,
        message_thread_id: threadId,
        parse_mode: 'Markdown',
        reply_to_message_id: replyToMessage?.message_id,
        ...addNavigationButtons(userId, commandHistory[userId]?.length - 1 || 0)
      });
    } catch (error) {
      if (error.response?.status === 429) {
        const retryAfter = error.response.data.parameters.retry_after || 1;
        logAction('rate_limit_error', { retryAfter });
        await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
        await bot.editMessageText(responseText, {
          chat_id: chatId,
          message_id: checkingMessage.message_id,
          message_thread_id: threadId,
          parse_mode: 'Markdown',
          reply_to_message_id: replyToMessage?.message_id,
          ...addNavigationButtons(userId, commandHistory[userId]?.length - 1 || 0)
        });
        return;
      }
      throw error;
    }

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
            `📡 *Detalles*: ${result.totalChannels || 0} canales\n` +
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