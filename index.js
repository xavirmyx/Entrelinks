const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');

// Token y Chat ID desde variables de entorno
const token = process.env.TOKEN || '7861676131:AAEIAjkMYnQPN858UPpJAG2bX5Wmxk6UFEg';
const bot = new TelegramBot(token);

// Configuración del servidor Express
const app = express();
const port = process.env.PORT || 10000; // Puerto asignado por Render o Replit
const adminGroupChatId = process.env.GROUP_DESTINO || '-1002516061331';

// Almacenamiento en memoria
let links = [];
let linkViews = new Map();
let userStats = new Map();
let maxLinksBeforeAlert = process.env.MAX_LINKS_BEFORE_ALERT || 10;

// Middleware para parsear JSON
app.use(express.json());

// Ruta para el webhook
app.post(`/bot${token}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Ruta para redirección de enlaces únicos
app.get('/link/:id', (req, res) => {
  const linkId = req.params.id;
  const userId = req.query.user_id;
  const link = links.find(l => l.uniqueId === linkId);
  if (!link) {
    console.log(`❌ Enlace único ${linkId} no encontrado`);
    return res.status(404).send('⚠️ Enlace no encontrado');
  }
  if (Date.now() > link.expirationTime) {
    console.log(`❌ Enlace único ${linkId} ha expirado`);
    return res.status(410).send('⚠️ Enlace ha expirado');
  }
  console.log(`🔗 Redirigiendo enlace único ${linkId} a ${link.original}`);
  res.redirect(link.original);

  if (!linkViews.has(link.number)) linkViews.set(link.number, []);
  const views = linkViews.get(link.number);
  if (!views.some(v => v.userId === userId)) {
    views.push({ userId, action: 'accedió' });
    linkViews.set(link.number, views);
  }
});

// Iniciar el servidor
app.listen(port, () => {
  console.log(`🚀 Servidor escuchando en el puerto ${port}`);
  const webhookUrl = process.env.WEBHOOK_URL || `https://entrelinks.onrender.com/bot${token}`;
  bot.setWebHook(webhookUrl)
    .then(() => console.log(`✅ Webhook configurado: ${webhookUrl}`))
    .catch(err => console.error(`❌ Error al configurar webhook: ${err.message}`));
});

// Utilidades
function generateUniqueId() {
  return crypto.randomBytes(8).toString('hex');
}

async function validateUrl(url) {
  try {
    const response = await axios.get(url, {
      timeout: 10000,
      maxRedirects: 5,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      },
    });
    console.log(`✅ Enlace validado: ${url} (Status: ${response.status})`);
    return true;
  } catch (error) {
    if (error.response?.status === 403) {
      console.log(`⚠️ Enlace ${url} devolvió 403, considerado válido`);
      return true;
    }
    console.error(`❌ Error al validar enlace ${url}: ${error.message}`);
    return false;
  }
}

function extractUrl(message) {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const text = message.text || message.caption || '';
  return text.match(urlRegex) || null;
}

function generateUniqueLink(originalUrl, linkNumber) {
  const uniqueId = generateUniqueId();
  const expirationTime = Date.now() + 24 * 60 * 60 * 1000; // 24 horas
  const baseUrl = process.env.WEBHOOK_URL || 'https://entrelinks.onrender.com';
  return {
    uniqueId,
    uniqueUrl: `${baseUrl}/link/${uniqueId}`,
    displayUrl: `https://entreshijoslink-${linkNumber}`,
    expirationTime,
  };
}

// Generación de enlaces
bot.on('message', async (msg) => {
  const chatId = msg.chat.id.toString();
  if (chatId !== adminGroupChatId) return;

  try {
    console.log(`📩 Mensaje recibido en ${chatId}:`, {
      text: msg.text,
      caption: msg.caption,
      hasPhoto: !!msg.photo,
      hasVideo: !!msg.video,
      hasDocument: !!msg.document,
    });

    const urls = extractUrl(msg);
    if (!urls) {
      console.log('ℹ️ No se encontraron enlaces.');
      return;
    }

    console.log(`🔗 Enlaces detectados: ${urls.join(', ')}`);
    let modifiedText = msg.text || msg.caption || '';
    let linkNumber = links.length + 1;

    for (const url of urls) {
      if (!(await validateUrl(url))) {
        console.log(`⛔ Enlace inválido, omitiendo: ${url}`);
        continue;
      }

      const { uniqueId, uniqueUrl, displayUrl } = generateUniqueLink(url, linkNumber);
      console.log(`🔧 ${url} -> ${uniqueUrl}`);
      links.push({
        original: url,
        unique: uniqueUrl,
        display: displayUrl,
        uniqueId,
        number: linkNumber,
        messageId: msg.message_id,
      });
      modifiedText = modifiedText.replace(url, `[${displayUrl}](${uniqueUrl}?user_id=${msg.from.id})`);
      linkNumber++;
    }

    if (modifiedText !== (msg.text || msg.caption || '')) {
      await bot.sendMessage(chatId, modifiedText, {
        reply_to_message_id: msg.message_id,
        parse_mode: 'Markdown',
      });
    }
  } catch (error) {
    console.error('❌ Error al procesar mensaje:', error.message);
    await bot.sendMessage(chatId, '⚠️ Error al procesar el mensaje.');
  }
});

// Registro de interacciones
bot.on('message', async (msg) => {
  const chatId = msg.chat.id.toString();
  const userId = msg.from.id;
  const username = msg.from.username ? `@${msg.from.username}` : `Usuario_${userId}`;
  const isForward = !!msg.forward_date;

  try {
    const admins = await bot.getChatAdministrators(adminGroupChatId);
    if (admins.some(admin => admin.user.id === userId)) return;

    const text = msg.text || msg.caption || '';
    const link = links.find(l => text.includes(l.display));
    if (!link) return;

    const linkNumber = link.number;
    const action = isForward ? 'reenvió' : 'vio/copió';
    console.log(`👤 ${username} ${action} enlace #${linkNumber} en ${chatId}`);

    if (!linkViews.has(linkNumber)) linkViews.set(linkNumber, []);
    const views = linkViews.get(linkNumber);
    if (!views.some(v => v.userId === userId)) {
      views.push({ userId, username, chatId, action });
      linkViews.set(linkNumber, views);

      const userStat = userStats.get(userId) || { username, count: 0 };
      userStat.count += 1;
      userStats.set(userId, userStat);

      if (userStat.count > maxLinksBeforeAlert) {
        await bot.sendMessage(adminGroupChatId, 
          `⚠️ ${username} ha interactuado con más de ${maxLinksBeforeAlert} enlaces.`);
      }
    }
  } catch (error) {
    console.error('❌ Error al registrar interacción:', error.message);
  }
});

// Comandos
bot.onText(/\/menu/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  try {
    const admins = await bot.getChatAdministrators(adminGroupChatId);
    const isAdmin = admins.some(admin => admin.user.id === userId);

    let menuText = '*📋 Menú del Bot EntreHijos*\n\n' +
      '*Comandos para Usuarios Normales*\n' +
      '🚨 */report <número>* - Reportar enlaces que no funcionan\n' +
      '📊 */my_stats* - Muestra tus estadísticas de interacciones\n' +
      '🔗 */active_links* - Lista enlaces activos\n' +
      'ℹ️ */link_info <número>* - Información de un enlace\n' +
      '📋 */ayuda* - Lista de comandos para usuarios\n';

    if (isAdmin && chatId === adminGroupChatId) {
      menuText += '\n*Comandos para Administradores*\n' +
        '🔍 */visto <número>* - Muestra quién vio un enlace\n' +
        '📈 */estadistica* - Estadísticas de interacciones\n' +
        '🚦 */status* - Estado del bot\n' +
        '🚫 */revoke <número>* - Revoca un enlace\n' +
        '⚠️ */alert <número>* - Alerta sobre un enlace\n' +
        '🔗 */list_links* - Lista todos los enlaces generados\n' +
        '⏳ */extend_link <número> <horas>* - Extiende la expiración de un enlace\n' +
        '📝 */generate_report* - Genera un reporte detallado\n' +
        '🧹 */clear_stats* - Limpia estadísticas\n' +
        '⚙️ */set_max_links <número>* - Establece el límite de enlaces antes de alerta';
    }

    await bot.sendMessage(chatId, menuText, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('❌ Error en /menu:', error.message);
    await bot.sendMessage(chatId, '⚠️ Error al mostrar el menú.');
  }
});

bot.onText(/\/ayuda/, (msg) => {
  const chatId = msg.chat.id;
  const ayudaText = '📋 **Comandos para Usuarios Normales**\n\n' +
    '🚨 **/report <número>** - Reportar enlaces que no funcionan\n' +
    '📊 **/my_stats** - Muestra tus estadísticas de interacciones\n' +
    '🔗 **/active_links** - Lista enlaces activos\n' +
    'ℹ️ **/link_info <número>** - Información de un enlace\n' +
    '📋 **/ayuda** - Lista de comandos para usuarios';
  bot.sendMessage(chatId, ayudaText, { parse_mode: 'Markdown' });
});

bot.onText(/\/report (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const linkNumber = parseInt(match[1]);
  const link = links.find(l => l.number === linkNumber);
  if (!link) {
    return bot.sendMessage(chatId, '⚠️ Enlace no encontrado.');
  }
  await bot.sendMessage(adminGroupChatId, 
    `🚨 Reporte: El enlace #${linkNumber} (${link.display}) fue reportado como no funcional por @${msg.from.username || 'Usuario_' + msg.from.id}`);
  bot.sendMessage(chatId, '✅ Reporte enviado a los administradores.');
});

bot.onText(/\/my_stats/, (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const userStat = userStats.get(userId) || { username: msg.from.username || `Usuario_${userId}`, count: 0 };
  bot.sendMessage(chatId, 
    `📊 **Tus Estadísticas**\nUsuario: ${userStat.username}\nInteracciones: ${userStat.count}`, 
    { parse_mode: 'Markdown' });
});

bot.onText(/\/active_links/, (msg) => {
  const chatId = msg.chat.id;
  const activeLinks = links.filter(l => Date.now() <= l.expirationTime);
  if (activeLinks.length === 0) {
    return bot.sendMessage(chatId, 'ℹ️ No hay enlaces activos.');
  }
  const linkList = activeLinks.map(l => `#${l.number}: ${l.display}`).join('\n');
  bot.sendMessage(chatId, `🔗 **Enlaces Activos**\n${linkList}`, { parse_mode: 'Markdown' });
});

bot.onText(/\/link_info (\d+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const linkNumber = parseInt(match[1]);
  const link = links.find(l => l.number === linkNumber);
  if (!link) {
    return bot.sendMessage(chatId, '⚠️ Enlace no encontrado.');
  }
  const expires = new Date(link.expirationTime).toLocaleString();
  bot.sendMessage(chatId, 
    `ℹ️ **Información del Enlace #${linkNumber}**\n` +
    `URL Mostrada: ${link.display}\n` +
    `URL Original: ${link.original}\n` +
    `Expira: ${expires}`, 
    { parse_mode: 'Markdown' });
});

bot.onText(/\/visto (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const linkNumber = parseInt(match[1]);
  const userId = msg.from.id;

  try {
    const admins = await bot.getChatAdministrators(adminGroupChatId);
    if (!admins.some(admin => admin.user.id === userId)) {
      return bot.sendMessage(chatId, '🚫 Solo admins pueden usar este comando.');
    }
    const link = links.find(l => l.number === linkNumber);
    if (!link) {
      return bot.sendMessage(chatId, '⚠️ Enlace no encontrado.');
    }
    const views = linkViews.get(linkNumber) || [];
    if (views.length === 0) {
      return bot.sendMessage(chatId, 'ℹ️ Sin interacciones.');
    }
    const viewList = views.map(v => `${v.username} ${v.action}`).join('\n');
    await bot.sendMessage(chatId, `**Interacciones del enlace #${linkNumber}**\n${viewList}`, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('❌ Error en /visto:', error.message);
    await bot.sendMessage(chatId, '⚠️ Error al procesar /visto.');
  }
});

bot.onText(/\/estadistica/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  try {
    const admins = await bot.getChatAdministrators(adminGroupChatId);
    if (!admins.some(admin => admin.user.id === userId)) {
      return bot.sendMessage(chatId, '🚫 Solo admins pueden usar este comando.');
    }
    if (userStats.size === 0) {
      return bot.sendMessage(chatId, 'ℹ️ Sin estadísticas.');
    }
    const sortedStats = Array.from(userStats.entries())
      .map(([id, stat]) => ({ id, ...stat }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
    const statsText = sortedStats.map((stat, i) => `${i + 1}. ${stat.username} - ${stat.count} interacciones`).join('\n');
    await bot.sendMessage(chatId, `**Estadísticas Top 10**\n${statsText}`, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('❌ Error en /estadistica:', error.message);
    await bot.sendMessage(chatId, '⚠️ Error al procesar /estadistica.');
  }
});

bot.onText(/\/status/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  try {
    const admins = await bot.getChatAdministrators(adminGroupChatId);
    if (!admins.some(admin => admin.user.id === userId)) {
      return bot.sendMessage(chatId, '🚫 Solo admins pueden usar este comando.');
    }
    const statusText = `**Estado del Bot EntreHijos**\n` +
      `Enlaces generados: ${links.length}\n` +
      `Usuarios activos: ${userStats.size}\n` +
      `Bot operativo en puerto: ${port}`;
    await bot.sendMessage(chatId, statusText, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('❌ Error en /status:', error.message);
    await bot.sendMessage(chatId, '⚠️ Error al procesar /status.');
  }
});

bot.onText(/\/revoke (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const linkNumber = parseInt(match[1]);
  const userId = msg.from.id;

  try {
    const admins = await bot.getChatAdministrators(adminGroupChatId);
    if (!admins.some(admin => admin.user.id === userId)) {
      return bot.sendMessage(chatId, '🚫 Solo admins pueden usar este comando.');
    }
    const linkIndex = links.findIndex(l => l.number === linkNumber);
    if (linkIndex === -1) {
      return bot.sendMessage(chatId, '⚠️ Enlace no encontrado.');
    }
    links.splice(linkIndex, 1);
    await bot.sendMessage(chatId, `✅ Enlace #${linkNumber} revocado.`);
  } catch (error) {
    console.error('❌ Error en /revoke:', error.message);
    await bot.sendMessage(chatId, '⚠️ Error al procesar /revoke.');
  }
});

bot.onText(/\/alert (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const linkNumber = parseInt(match[1]);
  const userId = msg.from.id;

  try {
    const admins = await bot.getChatAdministrators(adminGroupChatId);
    if (!admins.some(admin => admin.user.id === userId)) {
      return bot.sendMessage(chatId, '🚫 Solo admins pueden usar este comando.');
    }
    const link = links.find(l => l.number === linkNumber);
    if (!link) {
      return bot.sendMessage(chatId, '⚠️ Enlace no encontrado.');
    }
    const alertMessage = `⚠️ **Alerta**: Posible uso indebido del enlace #${linkNumber}.`;
    await bot.sendMessage(chatId, alertMessage, { parse_mode: 'Markdown' });
    for (const admin of admins) {
      await bot.sendMessage(admin.user.id, alertMessage, { parse_mode: 'Markdown' });
    }
    await bot.sendMessage(chatId, '✅ Alerta enviada a admins.');
  } catch (error) {
    console.error('❌ Error en /alert:', error.message);
    await bot.sendMessage(chatId, '⚠️ Error al procesar /alert.');
  }
});

bot.onText(/\/list_links/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  try {
    const admins = await bot.getChatAdministrators(adminGroupChatId);
    if (!admins.some(admin => admin.user.id === userId)) {
      return bot.sendMessage(chatId, '🚫 Solo admins pueden usar este comando.');
    }
    if (links.length === 0) {
      return bot.sendMessage(chatId, 'ℹ️ No hay enlaces generados.');
    }
    const linkList = links.map(l => 
      `#${l.number}: ${l.display} (Expira: ${new Date(l.expirationTime).toLocaleString()})`
    ).join('\n');
    await bot.sendMessage(chatId, `🔗 **Lista de Enlaces**\n${linkList}`, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('❌ Error en /list_links:', error.message);
    await bot.sendMessage(chatId, '⚠️ Error al procesar /list_links.');
  }
});

bot.onText(/\/extend_link (\d+) (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const linkNumber = parseInt(match[1]);
  const hours = parseInt(match[2]);
  const userId = msg.from.id;

  try {
    const admins = await bot.getChatAdministrators(adminGroupChatId);
    if (!admins.some(admin => admin.user.id === userId)) {
      return bot.sendMessage(chatId, '🚫 Solo admins pueden usar este comando.');
    }
    const link = links.find(l => l.number === linkNumber);
    if (!link) {
      return bot.sendMessage(chatId, '⚠️ Enlace no encontrado.');
    }
    link.expirationTime += hours * 60 * 60 * 1000;
    await bot.sendMessage(chatId, 
      `⏳ Enlace #${linkNumber} extendido por ${hours} horas. Nueva expiración: ${new Date(link.expirationTime).toLocaleString()}`);
  } catch (error) {
    console.error('❌ Error en /extend_link:', error.message);
    await bot.sendMessage(chatId, '⚠️ Error al procesar /extend_link.');
  }
});

bot.onText(/\/generate_report/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  try {
    const admins = await bot.getChatAdministrators(adminGroupChatId);
    if (!admins.some(admin => admin.user.id === userId)) {
      return bot.sendMessage(chatId, '🚫 Solo admins pueden usar este comando.');
    }
    if (links.length === 0) {
      return bot.sendMessage(chatId, 'ℹ️ No hay datos para generar un reporte.');
    }
    const report = links.map(l => {
      const views = linkViews.get(l.number) || [];
      return `#${l.number}: ${l.display} - ${views.length} interacciones`;
    }).join('\n');
    await bot.sendMessage(chatId, `📝 **Reporte Detallado**\n${report}`, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('❌ Error en /generate_report:', error.message);
    await bot.sendMessage(chatId, '⚠️ Error al procesar /generate_report.');
  }
});

bot.onText(/\/clear_stats/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  try {
    const admins = await bot.getChatAdministrators(adminGroupChatId);
    if (!admins.some(admin => admin.user.id === userId)) {
      return bot.sendMessage(chatId, '🚫 Solo admins pueden usar este comando.');
    }
    userStats.clear();
    linkViews.clear();
    await bot.sendMessage(chatId, '🧹 Estadísticas limpiadas exitosamente.');
  } catch (error) {
    console.error('❌ Error en /clear_stats:', error.message);
    await bot.sendMessage(chatId, '⚠️ Error al procesar /clear_stats.');
  }
});

bot.onText(/\/set_max_links (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const newMax = parseInt(match[1]);

  try {
    const admins = await bot.getChatAdministrators(adminGroupChatId);
    if (!admins.some(admin => admin.user.id === userId)) {
      return bot.sendMessage(chatId, '🚫 Solo admins pueden usar este comando.');
    }
    maxLinksBeforeAlert = newMax;
    await bot.sendMessage(chatId, `⚙️ Límite de enlaces antes de alerta establecido a ${newMax}.`);
  } catch (error) {
    console.error('❌ Error en /set_max_links:', error.message);
    await bot.sendMessage(chatId, '⚠️ Error al procesar /set_max_links.');
  }
});

console.log('🚀 Bot iniciado correctamente 🎉');