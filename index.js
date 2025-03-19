const TelegramBot = require('node-telegram-bot-api');
const express = require('express');

// Token del bot
const token = '7861676131:AAFLv4dBIFiHV1OYc8BJH2U8kWPal7lpBMQ';
const bot = new TelegramBot(token);

// Configuración del servidor Express
const app = express();
const port = process.env.PORT || 10000; // Render usa process.env.PORT, por defecto 10000

// Middleware para parsear JSON
app.use(express.json());

// Configuración del webhook
const webhookUrl = 'https://entrelinks.onrender.com';

// Almacenar usuarios advertidos en memoria
let warnedUsers = {};

// Ruta para el webhook
app.post(`/bot${token}`, (req, res) => {
  console.log('📩 Recibida actualización de Telegram:', JSON.stringify(req.body));
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Ruta para la raíz (/)
app.get('/', (req, res) => {
  res.send('Bot is running');
});

// Iniciar el servidor
app.listen(port, async () => {
  console.log(`🚀 Servidor escuchando en el puerto ${port}`);

  // Configurar el webhook
  await setWebhookWithRetry();
});

// Función para configurar el webhook con manejo de errores 429
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
      return setWebhookWithRetry(); // Reintentar
    }
    console.error(`❌ Error al configurar webhook: ${error.message}`);
  }
}

// Verificar si el usuario tiene foto de perfil pública y @username
async function checkUserProfile(user, chatId) {
  let hasPublicPhoto = true;
  let hasUsername = !!user.username;

  try {
    const photos = await bot.getUserProfilePhotos(user.id);
    hasPublicPhoto = photos.total_count > 0;
  } catch (error) {
    console.error(`❌ Error al verificar foto de perfil de ${user.id}: ${error.message}`);
    hasPublicPhoto = false; // Asumimos que no tiene foto pública si hay un error
  }

  return { hasPublicPhoto, hasUsername };
}

// Función para enviar advertencia a un usuario en el grupo
async function warnUserInGroup(user, chatId, reason) {
  const username = user.username ? `@${user.username}` : user.first_name;
  const userId = user.id;
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toLocaleDateString('es-ES', { day: 'numeric', month: 'long' });

  const message = `⚠️ ${username} (ID: ${userId}),\n` +
    `No tienes ${reason}. Por favor, configúralo antes del ${tomorrowStr}, ` +
    `o serás expulsado del grupo.\n\n` +
    `📢 Equipo de Administración Entre Hijos`;

  try {
    await bot.sendMessage(chatId, message);
    warnedUsers[user.id] = { username: user.username || user.first_name, reason, warnedAt: new Date() };
    console.log(`📩 Advertencia enviada a ${username} (ID: ${userId}) por: ${reason}`);
  } catch (error) {
    console.error(`❌ Error al enviar advertencia en el grupo para ${user.id}: ${error.message}`);
  }
}

// Comando /m1: Mostrar lista de comandos
bot.onText(/\/m1/, async (msg) => {
  const chatId = msg.chat.id;
  const commandsList = `📋 **Lista de Comandos - Equipo de Administración Entre Hijos** 📋\n\n` +
    `🔍 **/busqueda**\n` +
    `   Escanea el grupo y detecta usuarios sin foto de perfil pública o @username. Envía una advertencia en el grupo a cada usuario detectado.\n\n` +
    `🧹 **/limpiar**\n` +
    `   Genera mensajes de expulsión para los usuarios advertidos (formato: /kick @username (Motivo: ...)). Limpia la lista de advertidos.\n\n` +
    `📜 **/advertidos**\n` +
    `   Muestra una lista de los usuarios que han sido advertidos, con el motivo y la fecha de advertencia.\n\n` +
    `ℹ️ **/m1**\n` +
    `   Muestra esta lista de comandos con una descripción detallada.\n\n` +
    `📢 **Funcionalidades automáticas**:\n` +
    `   - Detecta cambios de @username y lo notifica en el grupo.\n` +
    `   - Restringe mensajes de usuarios sin foto de perfil pública o @username, enviando una advertencia en el grupo.\n\n` +
    `📢 Equipo de Administración Entre Hijos`;

  await bot.sendMessage(chatId, commandsList, { parse_mode: 'Markdown' });
});

// Comando /busqueda: Escanear el grupo y advertir a los usuarios en el grupo
bot.onText(/\/busqueda/, async (msg) => {
  const chatId = msg.chat.id;
  if (msg.chat.type !== 'group' && msg.chat.type !== 'supergroup') {
    await bot.sendMessage(chatId, '🚫 Este comando solo puede usarse en grupos.');
    return;
  }

  try {
    await bot.sendMessage(chatId, '🔍 Iniciando búsqueda de usuarios sin foto de perfil pública o @username...');
    const botId = (await bot.getMe()).id;
    const members = await bot.getChatMembersCount(chatId);
    const chatMembers = [];

    // Obtener miembros del grupo (limitado a 200 por solicitud)
    let offset = 0;
    const limit = 200;
    while (offset < members) {
      try {
        const batch = await bot.getChatMembers(chatId, { offset, limit });
        chatMembers.push(...batch);
        offset += limit;
      } catch (error) {
        console.error(`❌ Error al obtener miembros (offset ${offset}): ${error.message}`);
        break;
      }
      // Pequeña pausa para evitar límites de la API
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    const uniqueMembers = chatMembers
      .map(member => member.user)
      .filter((member, index, self) => 
        index === self.findIndex(m => m.id === member.id) && member.id !== botId && !member.is_bot);

    let warnedCount = 0;
    for (const member of uniqueMembers) {
      const { hasPublicPhoto, hasUsername } = await checkUserProfile(member, chatId);
      if (!hasPublicPhoto) {
        await warnUserInGroup(member, chatId, 'foto de perfil pública');
        warnedCount++;
      } else if (!hasUsername) {
        await warnUserInGroup(member, chatId, '@username');
        warnedCount++;
      }
      // Pequeña pausa para evitar límites de la API
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    await bot.sendMessage(chatId, `✅ Búsqueda completada. Se advirtieron a ${warnedCount} usuarios.\n` +
      `Usa /advertidos para ver la lista de advertidos o /limpiar para preparar la expulsión.`);
  } catch (error) {
    console.error(`❌ Error en /busqueda: ${error.message}`);
    await bot.sendMessage(chatId, '❌ Ocurrió un error al realizar la búsqueda. Intenta de nuevo más tarde.');
  }
});

// Comando /limpiar: Generar mensajes de expulsión
bot.onText(/\/limpiar/, async (msg) => {
  const chatId = msg.chat.id;
  if (msg.chat.type !== 'group' && msg.chat.type !== 'supergroup') {
    await bot.sendMessage(chatId, '🚫 Este comando solo puede usarse en grupos.');
    return;
  }

  if (Object.keys(warnedUsers).length === 0) {
    await bot.sendMessage(chatId, 'ℹ️ No hay usuarios advertidos para limpiar.');
    return;
  }

  await bot.sendMessage(chatId, '📋 Generando mensajes de expulsión...');
  for (const userId in warnedUsers) {
    const user = warnedUsers[userId];
    const reason = user.reason === 'foto de perfil pública' ? 'falta foto de perfil pública' : 'falta @username';
    const message = `/kick @${user.username} (Motivo: ${reason})`;
    await bot.sendMessage(chatId, message);
    // Pequeña pausa para evitar límites de la API
    await new Promise(resolve => setTimeout(resolve, 50));
  }

  // Limpiar la lista de advertidos después de generar los mensajes
  warnedUsers = {};
  await bot.sendMessage(chatId, '✅ Mensajes de expulsión generados. La lista de advertidos ha sido limpiada.');
});

// Comando /advertidos: Mostrar lista de usuarios advertidos
bot.onText(/\/advertidos/, async (msg) => {
  const chatId = msg.chat.id;
  if (msg.chat.type !== 'group' && msg.chat.type !== 'supergroup') {
    await bot.sendMessage(chatId, '🚫 Este comando solo puede usarse en grupos.');
    return;
  }

  if (Object.keys(warnedUsers).length === 0) {
    await bot.sendMessage(chatId, 'ℹ️ No hay usuarios advertidos actualmente.');
    return;
  }

  let message = '📜 Lista de usuarios advertidos:\n\n';
  for (const userId in warnedUsers) {
    const user = warnedUsers[userId];
    const warnedAt = new Date(user.warnedAt).toLocaleString('es-ES');
    message += `👤 ${user.username}\n` +
      `   Motivo: falta ${user.reason}\n` +
      `   Advertido el: ${warnedAt}\n\n`;
  }
  message += '📢 Equipo de Administración Entre Hijos';

  await bot.sendMessage(chatId, message);
});

// Detectar cambios de @username (similar a SangMata)
bot.on('chat_member', async (msg) => {
  const user = msg.new_chat_member?.user;
  if (!user) return;

  const oldUsername = msg.old_chat_member?.user?.username;
  const newUsername = user.username;

  if (oldUsername !== newUsername && oldUsername && newUsername) {
    const chatId = msg.chat.id;
    await bot.sendMessage(chatId, `🔄 @${oldUsername} ha cambiado su nombre a @${newUsername}`);
  }
});

// Restringir mensajes de usuarios sin foto de perfil pública o @username
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  if (msg.chat.type !== 'group' && msg.chat.type !== 'supergroup') return;
  if (msg.from.is_bot) return;
  if (msg.text && msg.text.startsWith('/')) return; // Permitir comandos

  const { hasPublicPhoto, hasUsername } = await checkUserProfile(msg.from, chatId);
  if (!hasPublicPhoto || !hasUsername) {
    const username = hasUsername ? `@${msg.from.username}` : msg.from.first_name;
    const reason = !hasPublicPhoto ? 'foto de perfil pública' : '@username';

    // Eliminar el mensaje del usuario
    try {
      await bot.deleteMessage(chatId, msg.message_id);
    } catch (error) {
      console.error(`❌ Error al eliminar mensaje de ${username}: ${error.message}`);
    }

    // Enviar advertencia en el grupo
    await bot.sendMessage(chatId, `🚫 ${username}, por favor configura tu ${reason} para poder hablar en el grupo.\n` +
      `📢 Equipo de Administración Entre Hijos`);
  }
});

console.log('🚀 Bot iniciado correctamente 🎉');