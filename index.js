const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

// Token del bot
const token = '7861676131:AAFLv4dBIFiHV1OYc8BJH2U8kWPal7lpBMQ';
const bot = new TelegramBot(token);

// URL de la lista M3U
const m3uUrl = 'http://tv.balkanci.net:8080/get.php?username=Kristijan&password=L2QJ4VvC4W&type=m3u_plus';

// Configuración del webhook
const webhookUrl = 'https://entrelinks.onrender.com';
bot.setWebHook(`${webhookUrl}/bot${token}`)
  .then(() => console.log(`✅ Webhook configurado: ${webhookUrl}/bot${token}`))
  .catch(err => console.error(`❌ Error al configurar webhook: ${err.message}`));

// Función para extraer contenido de la lista M3U y organizarlo por categorías
async function fetchContentFromM3U() {
  try {
    console.log(`Intentando cargar contenido desde: ${m3uUrl}`);
    const { data } = await axios.get(m3uUrl, { timeout: 15000 });
    console.log(`Datos recibidos: ${data.substring(0, 100)}...`);
    const lines = data.split('\n');
    const itemsByCategory = {};

    let currentItem = null;
    for (const line of lines) {
      if (line.startsWith('#EXTINF')) {
        const titleMatch = line.match(/,(.+)/);
        const groupMatch = line.match(/group-title="([^"]+)"/);
        if (titleMatch) {
          const title = titleMatch[1].trim();
          const category = groupMatch ? groupMatch[1].trim() : 'Otros';
          currentItem = { title, category };
        }
      } else if (line.startsWith('http') && currentItem) {
        currentItem.link = line.trim();
        if (!itemsByCategory[currentItem.category]) {
          itemsByCategory[currentItem.category] = [];
        }
        itemsByCategory[currentItem.category].push(currentItem);
        currentItem = null;
      }
    }

    console.log(`✅ Categorías extraídas: ${Object.keys(itemsByCategory).join(', ')}`);
    return itemsByCategory;
  } catch (error) {
    console.error(`❌ Error al extraer contenido de ${m3uUrl}: ${error.message}`);
    if (error.response) {
      console.error(`Código de estado: ${error.response.status}`);
      console.error(`Datos de respuesta: ${JSON.stringify(error.response.data)}`);
    }
    return {};
  }
}

// Menú principal con categorías
async function sendMainMenu(chatId) {
  console.log(`📤 Enviando menú principal a ${chatId}`);
  const itemsByCategory = await fetchContentFromM3U();
  bot.tempCategories = itemsByCategory;

  if (Object.keys(itemsByCategory).length === 0) {
    await bot.sendMessage(chatId, '⚠️ No se pudo cargar el contenido. Revisa si la lista M3U está disponible.');
    return;
  }

  const keyboard = Object.keys(itemsByCategory).map(category => [
    { text: category, callback_data: `category_${category}` },
  ]);

  const options = {
    reply_markup: {
      inline_keyboard: [
        ...keyboard,
        [{ text: '🔍 Buscar', callback_data: 'search' }],
        [{ text: 'ℹ️ Ayuda', callback_data: 'help' }],
      ],
    },
  };
  await bot.sendMessage(chatId, '🎬 Bienvenido al Bot\nElige una categoría:', options);
}

// Mostrar contenido de una categoría
async function sendCategoryContent(chatId, category) {
  const items = bot.tempCategories[category];

  if (!items || items.length === 0) {
    await bot.sendMessage(chatId, `⚠️ No hay contenido en la categoría "${category}".`);
    return;
  }

  const keyboard = items.slice(0, 20).map((item, index) => [
    { text: item.title, callback_data: `item_${category}_${index}` },
  ]);

  const options = {
    reply_markup: {
      inline_keyboard: [
        ...keyboard,
        [{ text: '🔙 Volver', callback_data: 'back_to_menu' }],
      ],
    },
  };
  await bot.sendMessage(chatId, `📋 Contenido en "${category}":`, options);
}

// Mostrar resultados de búsqueda
async function sendSearchResults(chatId, query) {
  const itemsByCategory = bot.tempCategories || (await fetchContentFromM3U());
  bot.tempCategories = itemsByCategory;

  const results = [];
  for (const [category, items] of Object.entries(itemsByCategory)) {
    items.forEach((item, index) => {
      if (item.title.toLowerCase().includes(query.toLowerCase())) {
        results.push({ category, index, title: item.title, link: item.link });
      }
    });
  }

  if (results.length === 0) {
    await bot.sendMessage(chatId, `⚠️ No se encontraron resultados para "${query}".`);
    return;
  }

  const keyboard = results.slice(0, 20).map(result => [
    { text: result.title, callback_data: `item_${result.category}_${result.index}` },
  ]);

  const options = {
    reply_markup: {
      inline_keyboard: [
        ...keyboard,
        [{ text: '🔙 Volver', callback_data: 'back_to_menu' }],
      ],
    },
  };
  await bot.sendMessage(chatId, `🔍 Resultados para "${query}":`, options);
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

// Comando /buscar
bot.onText(/\/buscar (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const query = match[1];
  console.log(`📩 Comando /buscar recibido de ${chatId}: ${query}`);
  sendSearchResults(chatId, query);
});

// Manejar callbacks de los botones
bot.on('callback_query', async (callbackQuery) => {
  const chatId = callbackQuery.message.chat.id;
  const data = callbackQuery.data;

  console.log(`📩 Callback recibido: ${data}`);
  await bot.answerCallbackQuery(callbackQuery.id);

  if (data.startsWith('category_')) {
    const category = data.replace('category_', '');
    await sendCategoryContent(chatId, category);
  } else if (data.startsWith('item_')) {
    const [_, category, index] = data.split('_');
    const item = bot.tempCategories[category][parseInt(index)];
    if (item) {
      const options = {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔙 Volver', callback_data: `category_${category}` }],
          ],
        },
      };
      await bot.sendMessage(chatId, `📺 ${item.title}\nReproduce aquí:\n${item.link}`, options);
    }
  } else if (data === 'search') {
    await bot.sendMessage(chatId, '🔍 Usa /buscar <nombre> para encontrar contenido.');
  } else if (data === 'back_to_menu') {
    await sendMainMenu(chatId);
  } else if (data === 'help') {
    await bot.sendMessage(chatId, 'ℹ️ Instrucciones:\n- /start o /menu: Ver categorías.\n- /buscar <nombre>: Buscar contenido.\n- Usa los botones para navegar.');
  }
});

// Mantener el proceso activo para Render (opcional, para depuración)
process.on('SIGTERM', () => {
  console.log('Recibida señal SIGTERM. Cerrando el bot...');
  process.exit(0);
});

console.log('🚀 Bot iniciado correctamente 🎉');