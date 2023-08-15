FROM node:lts-alpine

COPY package*.json ./

RUN npm install

COPY . .

CMD [ "node", "main.js" ]