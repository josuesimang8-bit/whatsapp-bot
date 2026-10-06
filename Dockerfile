FROM node:20-slim

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

RUN mkdir -p uploads auth_info_baileys && \
    chmod -R 777 uploads auth_info_baileys

EXPOSE 3000

CMD [ "node", "index.js" ]
