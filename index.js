const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const https = require('https'); // Para manejar SSL

// Token del bot
const token = '7861676131:AAFLv4dBIFiHV1OYc8BJH2U8kWPal7lpBMQ';
const bot = new TelegramBot(token);

// Configuración del servidor Express
const app = express();
const port = process.env.PORT || 10000;

// URL inicial de la lista IPTV M3U
let iptvUrl = 'https://coco3.jimaplus.xyz:8080/get.php?username=4679659584&password=4469385344&type=m3u_plus';

// Configuración de axios con agente HTTPS flexible
const axiosInstance = axios.create({
  httpsAgent: new https.Agent({
    rejectUnauthorized: false, // Ignora certificados no válidos (riesgoso, solo para pruebas)
    secureOptions: require('constants').SSL_OP_LEGACY_SERVER_CONNECT, // Permite conexiones legacy
  }),
});

// Middleware para parsear JSON
app.use(express.json());

// Ruta para el webhook
app.post(`/bot${token}`, (req, res) => {
  console.log('📩 Recibida actualización de Telegram:', JSON.stringify(req.body));
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Iniciar el servidor
app.listen(port, () => {
  console.log(`🚀 Servidor escuchando en el puerto ${port}`);
  const webhookUrl = process.env.WEBHOOK_URL || 'https://entrelinks.onrender.com';
  bot.setWebHook(`${webhookUrl}/bot${token}`)
    .then(() => console.log(`✅ Webhook configurado: ${webhookUrl}/bot${token}`))
    .catch(err => console.error(`❌ Error al configurar webhook: ${err.message}`));
});

// Función para extraer canales de la lista M3U
async function fetchChannels() {
  try {
    const { data } = await axiosInstance.get(iptvUrl, { timeout: 15000 });
    const lines = data.split('\n');
    const channels = {};

    let currentChannel = null;
    for (const line of lines) {
      if (line.startsWith('#EXTINF')) {
        const titleMatch = line.match(/group-title="([^"]+)".*?,(.+)/);
        if (titleMatch) {
          const category = titleMatch[1] || 'Sin categoría';
          const name = titleMatch[2].trim();
          currentChannel = { name, category };
          if (!channels[category]) channels[category] = [];
        }
      } else if (line.startsWith('http') && currentChannel) {
        currentChannel.link = line.trim();
        channels[currentChannel.category].push(currentChannel);
        currentChannel = null;
      }
    }

    console.log(`✅ Canales extraídos: ${Object.keys(channels).length} categorías`);
    return channels;
  } catch (error) {
    console.error(`❌ Error al extraer canales de IPTV: ${error.message}`);
    return {};
  }
}

// Función para generar un fragmento MP4 del stream
async function generateVideoFragment(streamUrl, chatId) {
  const outputPath = path.join(__dirname, `temp_${Date.now()}.mp4`);

  return new Promise((resolve, reject) => {
    ffmpeg(streamUrl)
      .output(outputPath)
      .format('mp4')
      .videoCodec('libx264')
      .audioCodec('aac')
      .duration(10)
      .on('end', () => {
        console.log(`✅ Fragmento generado: ${outputPath}`);
        resolve(outputPath);
      })
      .on('error', (err) => {
        console.error(`❌ Error al generar fragmento: ${err.message}`);
        reject(err);
      })
      .run();
  });
}

// Menú principal
async function sendMainMenu(chatId) {
  console.log(`📤 Enviando menú principal a ${chatId}`);
  const channels = await fetchChannels();
  const categories = Object.keys(channels);

  if (categories.length === 0) {
    await bot.sendMessage(chatId, `⚠️ No se pudieron cargar los canales de la lista IPTV (${iptvUrl}). Prueba con /setiptv <nueva-url>.`);
    return;
  }

  const keyboard = categories.slice(0, 10).map(category => [
    { text: category, callback_data: `category_${category}` },
  ]);

  const options = {
    reply_markup: {
      inline_keyboard: [...keyboard, [{ text: 'ℹ️ Ayuda', callback_data: 'help' }]],
    },
  };
  await bot.sendMessage(chatId, '📺 Bienvenido al Bot IPTV\nSelecciona una categoría:', options);
}

// Mostrar lista de canales
async function sendChannelList(chatId, category) {
  const channels = await fetchChannels();
  const channelList = channels[category] || [];

  if (channelList.length === 0) {
    await bot.sendMessage(chatId, `⚠️ No hay canales en ${category}.`);
    return;
  }

  const keyboard = channelList.slice(0, 20).map((channel, index) => [
    { text: channel.name, callback_data: `channel_${category}_${index}` },
  ]);

  const options = {
    reply_markup: {
      inline_keyboard: keyboard,
    },
  };
  await bot.sendMessage(chatId, `📺 Canales en ${category}:`, options);

  bot.tempChannels = channels;
}

// Comando /start
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  console.log(`📩 Comando /start recibido de ${chatId}`);
  sendMainMenu(chatId);
});

// Comando /menu
bot.onText(/\/menu/, (msg) => {
  const chatId = msg.chat.id;
  console.log(`📩 Comando /menu recibido de ${chatId}`);
  sendMainMenu(chatId);
});

// Comando /test
bot.onText(/\/test/, (msg) => {
  const chatId = msg.chat.id;
  console.log(`📩 Comando /test recibido de ${chatId}`);
  bot.sendMessage(chatId, '✅ ¡El bot está vivo!');
});

// Comando /setiptv para cambiar la URL
bot.onText(/\/setiptv (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const newUrl = match[1];
  console.log(`📩 Comando /setiptv recibido de ${chatId}: ${newUrl}`);

  iptvUrl = newUrl;
  bot.sendMessage(chatId, `✅ Lista IPTV actualizada a: ${newUrl}\nUsa /menu para ver los canales.`);
});

// Manejar callbacks de los botones
bot.on('callback_query', async (callbackQuery) => {
  const chatId = callbackQuery.message.chat.id;
  const data = callbackQuery.data;

  console.log(`📩 Callback recibido: ${data}`);
  await bot.answerCallbackQuery(callbackQuery.id);

  if (data.startsWith('category_')) {
    const category = data.replace('category_', '');
    await sendChannelList(chatId, category);
  } else if (data.startsWith('channel_')) {
    const [_, category, index] = data.split('_');
    const channel = bot.tempChannels[category][parseInt(index)];
    if (channel) {
      try {
        await bot.sendMessage(chatId, `📺 Generando fragmento de ${channel.name}...`);
        const videoPath = await generateVideoFragment(channel.link, chatId);

        await bot.sendVideo(chatId, videoPath, {
          caption: `📺 ${channel.name}`,
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔙 Volver al Menú', callback_data: 'back_to_menu' }],
            ],
          },
        });

        fs.unlink(videoPath, (err) => {
          if (err) console.error(`❌ Error al eliminar archivo: ${err.message}`);
        });
      } catch (error) {
        await bot.sendMessage(chatId, `⚠️ Error al reproducir ${channel.name}: ${error.message}`);
      }
    }
  } else if (data === 'back_to_menu') {
    await sendMainMenu(chatId);
  } else if (data === 'help') {
    await bot.sendMessage(chatId, 'ℹ️ Usa este bot para ver IPTV:\n- /start o /menu: Ver categorías.\n- /setiptv <URL>: Cambiar lista IPTV.\n- /test: Verificar estado.');
  }
});

console.log('🚀 Bot IPTV con Reproducción Directa iniciado correctamente 🎉');