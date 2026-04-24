const fs = require('fs');
const path = require('path');

const targetDir = __dirname;

// ფაილები, რომლებიც არ უნდა გადავიტანოთ, რომ აპლიკაცია არ გაფუჭდეს
const coreFiles = [
    'server.js', 'package.json', 'package-lock.json', '.env', 
    'run_me.bat', 'data.json', 'asana_lite.db', 'script.js', 
    'style.css', 'index.html', 'kanban.html', 'stats.html', 
    'export.html', 'calendar.html', 'login.html', 'organize.js'
];

// საქაღალდეები, რომლებსაც არ ვეხებით
const coreFolders = ['node_modules', 'uploads', '.git'];

async function organizeFiles() {
    console.log('📂 ფაილების დახარისხება დაწყებულია...');
    
    try {
        const items = await fs.promises.readdir(targetDir);

        for (const item of items) {
            const fullPath = path.join(targetDir, item);
            const stat = await fs.promises.stat(fullPath);

            // ვამოწმებთ არის თუ არა ფაილი და არ არის თუ არა სისტემური
            if (stat.isFile() && !coreFiles.includes(item)) {
                const ext = path.extname(item).slice(1).toLowerCase() || 'others';
                const destDir = path.join(targetDir, ext);

                // ვქმნით საქაღალდეს ფორმატის სახელით, თუ არ არსებობს
                if (!fs.existsSync(destDir)) {
                    await fs.promises.mkdir(destDir);
                }

                // გადატანა
                const destPath = path.join(destDir, item);
                await fs.promises.rename(fullPath, destPath);
                console.log(`✅ გადატანილია: ${item} -> ${ext}/`);
            }
        }
        console.log('✨ დახარისხება წარმატებით დასრულდა!');
    } catch (error) {
        console.error('❌ შეცდომა:', error);
    }
}

organizeFiles();