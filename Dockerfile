FROM node:20-slim

WORKDIR /usr/src/app

# Install FFmpeg for video processing and thumbnail generation
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

RUN mkdir -p uploads auth_info_baileys && \
    chmod -R 777 uploads auth_info_baileys

EXPOSE 3000

CMD [ "node", "index.js" ]
