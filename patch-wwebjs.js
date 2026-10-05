const fs = require('fs');
const path = require('path');

const clientJsPath = path.join(__dirname, 'node_modules', 'whatsapp-web.js', 'src', 'Client.js');

if (fs.existsSync(clientJsPath)) {
    let content = fs.readFileSync(clientJsPath, 'utf8');
    
    // 1. Fix hardcoded 30000 ms timeout for window.WWebJS
    if (content.includes('while (start > Date.now() - 30000)')) {
        content = content.replace(
            'while (start > Date.now() - 30000) {',
            'while (start > Date.now() - (this.options.authTimeoutMs || 180000)) {\n                        await this.pupPage.evaluate(LoadUtils).catch(() => {});'
        );
        console.log('Successfully patched Client.js ready timeout to authTimeoutMs (180s)!');
    } else {
        console.log('Client.js ready timeout already patched or pattern not found.');
    }

    // 2. Prevent unhandled ready timeout from crashing
    if (content.includes("throw 'ready timeout';")) {
        content = content.replace(
            "throw 'ready timeout';",
            "console.error('Warning: ready timeout reached, attempting to proceed anyway...');"
        );
        console.log('Successfully prevented fatal throw on ready timeout in Client.js!');
    }

    fs.writeFileSync(clientJsPath, content, 'utf8');
    console.log('Client.js patch applied.');
} else {
    console.log('node_modules/whatsapp-web.js/src/Client.js not found.');
}
