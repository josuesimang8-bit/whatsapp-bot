const { MessageMedia } = require('whatsapp-web.js');
const path = require('path');
const fs = require('fs');

const mediaPath = path.join(__dirname, '..', 'uploads', '1782558888713.ogg');
if (fs.existsSync(mediaPath)) {
    try {
        const media = MessageMedia.fromFilePath(mediaPath);
        console.log('Mimetype:', media.mimetype);
        console.log('Data length:', media.data.length);
        console.log('Filename:', media.filename);
    } catch (e) {
        console.error('Error loading media:', e);
    }
} else {
    console.log('File does not exist at:', mediaPath);
}
