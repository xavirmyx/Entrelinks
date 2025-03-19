FROM node:20

# Instalar FFmpeg
RUN apt-get update && apt-get install -y ffmpeg

# Directorio de trabajo
WORKDIR /app

# Copiar package.json y package-lock.json
COPY package*.json ./

# Instalar dependencias
RUN npm install

# Copiar el resto del código
COPY . .

# Exponer el puerto
EXPOSE 10000

# Comando para iniciar
CMD ["npm", "start"]