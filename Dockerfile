FROM ghcr.io/puppeteer/puppeteer:latest

# Switch to root to install packages or manage permissions if needed, 
# but the default user "pptruser" is safer. The base image default is "pptruser".
# We can copy files as pptruser.
USER pptruser

WORKDIR /usr/src/app

# Copy package files
COPY --chown=pptruser:pptruser package*.json ./

# Install dependencies (ignoring scripts if they try to install local chromium again)
RUN npm ci --omit=dev

# Copy application source code
COPY --chown=pptruser:pptruser . .

# Expose server port
EXPOSE 3000

# Run the app
CMD [ "node", "index.js" ]
