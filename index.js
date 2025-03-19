const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const axios = require('axios');

// Token del bot
const token = '7861676131:AAFLv4dBIFiHV1OYc8BJH2U8kWPal7lpBMQ';
const bot = new TelegramBot(token);

// Configuración del servidor Express
const app = express();
const port = process.env.PORT || 10000;

// Listas M3U predefinidas
const m3uLists = [
  {
    name: "CHUKYHOOD DEPORTES",
    image: "https://i.ibb.co/RbqRNzW/Chuky-Hood.jpg",
    url: "https://raw.githubusercontent.com/chukyvaliente/Chuky-Hood/main/Chuky-Hood"
  },
  {
    name: "CHUKYHOOD CINE",
    image: "https://i.ibb.co/vQJ9W7j/chuky.jpg",
    url: "https://raw.githubusercontent.com/chukyvaliente/chukycine/main/chukycine"
  }
];

// Middleware para parsear JSON
app.use(express.json());

// Ruta para el webhook
app.post(`/bot${token}`, (req, res) => {
  console.log('📩 Recibida actualización de Telegram:', JSON.stringify(req.body));
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Ruta para el reproductor web
app.get('/play', (req, res) => {
  const streamUrl = req.query.url;
  if (!streamUrl) {
    return res.status(400).send('No se proporcionó URL de stream.');
  }

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Reproductor M3U</title>
      <style>
        body { margin: 0; background: #000; display: flex; justify-content: center; align-items: center; height: 100vh; }
        video { width: 100%; max-width: 800px; height: auto; }
      </style>
    </head>
    <body>
      <video controls autoplay>
        <source src="${streamUrl}" type="application/x-mpegURL">
        Tu navegador no soporta el reproductor.
      </video>
    </body>
    </html>
  `;
  res.send(html);
});

// Iniciar el servidor
app.listen(port, () => {
  console.log(`🚀 Servidor escuchando en el puerto ${port}`);
  const webhookUrl = process.env.WEBHOOK_URL || 'https://entrelinks.onrender.com';
  bot.setWebHook(`${webhookUrl}/bot${token}`)
    .then(() => console.log(`✅ Webhook configurado: ${webhookUrl}/bot${token}`))
    .catch(err => console.error(`❌ Error al configurar webhook: ${err.message}`));
});

// Función para extraer películas de una lista M3U
async function fetchMoviesFromM3U(m3uUrl) {
  try {
    const { data } = await axios.get(m3uUrl, { timeout: 10000 });
    const lines = data.split('\n');
    const movies = [];

    let currentMovie = null;
    for (const line of lines) {
      if (line.startsWith('#EXTINF')) {
        const titleMatch = line.match(/,(.+)/);
        if (titleMatch) {
          currentMovie = { title: titleMatch[1].trim() };
        }
      } else if (line.startsWith('http') && currentMovie) {
        currentMovie.link = line.trim();
        movies.push(currentMovie);
        currentMovie = null;
      }
    }

    console.log(`✅ Películas extraídas de ${m3uUrl}: ${movies.length}`);
    return movies;
  } catch (error) {
    console.error(`❌ Error al extraer películas de ${m3uUrl}: ${error.message}`);
    return [];
  }
}

// Menú principal con listas M3U
async function sendMainMenu(chatId) {
  console.log(`📤 Enviando menú principal a ${chatId}`);
  const keyboard = m3uLists.map((list, index) => [
    { text: list.name, callback_data: `list_${index}` },
  ]);

  const options = {
    reply_markup: {
      inline_keyboard: [
        ...keyboard,
        [{ text: '🔍 Buscar película', callback_data: 'search' }],
        [{ text: 'ℹ️ Ayuda', callback_data: 'help' }],
      ],
    },
  };
  await bot.sendMessage(chatId, '🎬 Bienvenido al Bot de Películas M3U\nSelecciona una lista:', options);
}

// Mostrar películas de una lista
async function sendMovieList(chatId, listIndex) {
  const list = m3uLists[listIndex];
  const movies = await fetchMoviesFromM3U(list.url);

  if (movies.length === 0) {
    await bot.sendMessage(chatId, `⚠️ No se pudieron cargar películas de "${list.name}".`);
    return;
  }

  const keyboard = movies.slice(0, 20).map((movie, index) => [
    { text: movie.title, callback_data: `movie_${listIndex}_${index}` },
  ]);

  const options = {
    reply_markup: {
      inline_keyboard: [
        ...keyboard,
        [{ text: '🔙 Retroceder', callback_data: 'back_to_menu' }],
      ],
    },
  };
  await bot.sendMessage(chatId, `🎬 Películas en "${list.name}":`, options);

  bot.tempMovies = bot.tempMovies || {};
  bot.tempMovies[listIndex] = movies;
}

// Mostrar resultados de búsqueda
async function sendSearchResults(chatId, query) {
  const allMovies = {};
  for (let i = 0; i < m3uLists.length; i++) {
    allMovies[i] = await fetchMoviesFromM3U(m3uLists[i].url);
  }

  const results = [];
  for (const [listIndex, movies] of Object.entries(allMovies)) {
    movies.forEach((movie, movieIndex) => {
      if (movie.title.toLowerCase().includes(query.toLowerCase())) {
        results.push({ listIndex: parseInt(listIndex), movieIndex, title: movie.title, link: movie.link });
      }
    });
  }

  if (results.length === 0) {
    await bot.sendMessage(chatId, `⚠️ No se encontraron resultados para "${query}".`);
    return;
  }

  const keyboard = results.slice(0, 20).map(result => [
    { text: result.title, callback_data: `movie_${result.listIndex}_${result.movieIndex}` },
  ]);

  const options = {
    reply_markup: {
      inline_keyboard: [
        ...keyboard,
        [{ text: '🔙 Retroceder', callback_data: 'back_to_menu' }],
      ],
    },
  };
  await bot.sendMessage(chatId, `🎬 Resultados para "${query}":`, options);

  bot.tempMovies = allMovies;
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
  const webhookUrl = process.env.WEBHOOK_URL || 'https://entrelinks.onrender.com';

  console.log(`📩 Callback recibido: ${data}`);
  await bot.answerCallbackQuery(callbackQuery.id);

  if (data.startsWith('list_')) {
    const listIndex = parseInt(data.split('_')[1]);
    await sendMovieList(chatId, listIndex);
  } else if (data.startsWith('movie_')) {
    const [_, listIndex, movieIndex] = data.split('_').map(Number);
    const movie = bot.tempMovies[listIndex][movieIndex];
    if (movie) {
      const playUrl = `${webhookUrl}/play?url=${encodeURIComponent(movie.link)}`;
      const options = {
        reply_markup: {
          inline_keyboard: [
            [{ text: '▶️ Reproducir', url: playUrl }],
            [{ text: '🔙 Retroceder', callback_data: 'back_to_menu' }],
          ],
        },
      };
      await bot.sendMessage(chatId, `🎬 ${movie.title}\nHaz clic para reproducir:`, options);
    }
  } else if (data === 'search') {
    await bot.sendMessage(chatId, '🔍 Escribe /buscar <nombre de la película> para buscar.');
  } else if (data === 'back_to_menu') {
    await sendMainMenu(chatId);
  } else if (data === 'help') {
    await bot.sendMessage(chatId, 'ℹ️ Usa este bot para ver películas desde listas M3U:\n- /start o /menu: Ver listas.\n- /buscar <nombre>: Buscar una película.\n- /test: Verificar estado.');
  }
});

console.log('🚀 Bot de Películas M3U iniciado correctamente 🎉');