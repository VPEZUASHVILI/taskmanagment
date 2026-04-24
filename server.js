require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const ExcelJS = require('exceljs');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const session = require('express-session');
const msal = require('@azure/msal-node');
const axios = require('axios');
const http = require('http');
const { Server } = require("socket.io");
const app = express();
const server = http.createServer(app);
const io = new Server(server);
let PORT = 8080;

// ფაილის გზა, სადაც მონაცემები შეინახება
const UPLOADS_DIR = path.join(__dirname, 'uploads');

// შევქმნათ uploads საქაღალდე თუ არ არსებობს
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);

// Multer-ის კონფიგურაცია ფაილების შესანახად
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + '-' + file.originalname);
    }
});
const upload = multer({ storage: storage });

// SQLite მონაცემთა ბაზის ინიციალიზაცია
const DB_PATH = path.join(__dirname, 'asana_lite.db');
const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) {
        console.error('Error connecting to database:', err.message);
    } else {
        console.log('Connected to the SQLite database.');
        db.run(`CREATE TABLE IF NOT EXISTS tasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT,
            deadline TEXT,
            assignee TEXT,
            priority TEXT,
            client TEXT,
            requirements TEXT,
            comment TEXT,
            status TEXT,
            reminderTime TEXT,
            attachments TEXT,
            subtasks TEXT
        )`);
        db.run(`CREATE TABLE IF NOT EXISTS employees (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT,
            position TEXT
        )`);
        db.run(`CREATE TABLE IF NOT EXISTS notifications (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            text TEXT,
            date TEXT,
            read INTEGER
        )`);
        db.run(`CREATE TABLE IF NOT EXISTS activity_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id INTEGER,
            action TEXT,
            details TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
        db.run(`CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE,
            password TEXT,
            avatar TEXT
        )`, () => {
            db.run(`INSERT OR IGNORE INTO users (username, password) VALUES ('admin', 'admin123')`);
        });
        db.run(`ALTER TABLE users ADD COLUMN avatar TEXT`, (err) => { /* იგნორირება თუ სვეტი უკვე არსებობს */ });
    }
});

// Socket.io კავშირი
io.on('connection', (socket) => {
    console.log('User connected to real-time sync');
    socket.on('disconnect', () => console.log('User disconnected'));
});

// დამხმარე ფუნქცია ყველა კლიენტის განახლებისთვის
function notifyClients() {
    io.emit('tasksUpdated');
}

// Microsoft Graph კონფიგურაცია (აქ ჩაწერეთ თქვენი მონაცემები Azure-დან)
const msalConfig = {
    auth: {
        clientId: process.env.CLIENT_ID, 
        authority: "https://login.microsoftonline.com/common",
        clientSecret: process.env.CLIENT_SECRET,
    }
};

const pca = new msal.ConfidentialClientApplication(msalConfig);
const REDIRECT_URI = `http://localhost:8080/redirect`;

// დედლაინის ავტომატური განსაზღვრის ფუნქცია
function determineDeadline(subject) {
    // ვეძებთ თარიღს სათაურში (ფორმატი: YYYY-MM-DD)
    const dateRegex = /\d{4}-\d{2}-\d{2}/;
    const match = subject.match(dateRegex);
    if (match) return match[0];

    // თუ სათაურში თარიღი არ არის, ავტომატურად ვამატებთ 3 დღეს დღევანდელიდან
    const date = new Date();
    date.setDate(date.getDate() + 3);
    return date.toISOString().split('T')[0];
}


// დამხმარე ფუნქცია აქტივობის ჩასაწერად
function logActivity(taskId, action, details = '') {
    db.run("INSERT INTO activity_log (task_id, action, details) VALUES (?, ?, ?)", [taskId, action, details]);
}

// საწყისი მონაცემების ინიციალიზაცია
let employees = []; // მონაცემთა ბაზიდან წამოვიღებთ
let tasks = [];     // მონაცემთა ბაზიდან წამოვიღებთ
let notifications = []; // მონაცემთა ბაზიდან წამოვიღებთ

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// სესიის კონფიგურაცია
app.use(session({
    secret: process.env.SESSION_SECRET || 'fallback-secret',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false } // ლოკალური ტესტირებისთვის false
}));

// ავტორიზაციის შემოწმების Middleware
const requireAuth = (req, res, next) => {
    const publicPaths = ['/login', '/auth/login', '/style.css'];
    if (req.session.user || publicPaths.includes(req.path)) {
        return next();
    }
    res.redirect('/login');
};

app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'login.html'));
});

app.post('/auth/login', (req, res) => {
    const { username, password } = req.body;
    db.get("SELECT * FROM users WHERE username = ? AND password = ?", [username, password], (err, row) => {
        if (row) {
            req.session.user = row.username;
            res.redirect('/');
        } else {
            res.send("<script>alert('არასწორი მონაცემები'); window.location='/login';</script>");
        }
    });
});

app.get('/auth/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

app.use(requireAuth);
app.use(express.static(__dirname));
app.use('/uploads', express.static(UPLOADS_DIR)); // ფაილების წვდომისთვის

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/kanban', (req, res) => {
    res.sendFile(path.join(__dirname, 'kanban.html'));
});

app.get('/calendar', (req, res) => {
    res.sendFile(path.join(__dirname, 'calendar.html'));
});

app.get('/stats', (req, res) => {
    res.sendFile(path.join(__dirname, 'stats.html'));
});

app.get('/export-page', (req, res) => {
    res.sendFile(path.join(__dirname, 'export.html'));
});

// API: მომხმარებლის მონაცემების განახლება
app.post('/api/user/update', upload.single('avatar'), (req, res) => {
    const { newUsername, oldPassword, newPassword } = req.body;
    const currentUsername = req.session.user;
    const avatarPath = req.file ? req.file.path : null;

    let query = `UPDATE users SET username = ?, password = ?`;
    let params = [newUsername, newPassword];
    
    if (avatarPath) {
        query += `, avatar = ?`;
        params.push(avatarPath);
    }
    
    query += ` WHERE username = ? AND password = ?`;
    params.push(currentUsername, oldPassword);

    db.run(query, params, function(err) {
            if (err || this.changes === 0) {
                return res.status(400).json({ error: "პაროლი არასწორია ან მომხმარებელი ვერ მოიძებნა" });
            }
            req.session.user = newUsername; // სესიის განახლება
            res.json({ success: true });
        }
    );
});

// API: მიმდინარე მომხმარებლის ინფორმაცია
app.get('/api/user/info', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: "Unauthorized" });
    
    db.get("SELECT username, avatar FROM users WHERE username = ?", [req.session.user], (err, row) => {
        if (err || !row) {
            res.status(404).json({ error: "მომხმარებელი ვერ მოიძებნა" });
        } else {
            res.json(row);
        }
    });
});

// API: მონაცემების გაცემა
app.get('/api/data', async (req, res) => {
    try {
        const tasksData = await new Promise((resolve, reject) => {
            db.all("SELECT * FROM tasks", [], (err, rows) => {
                if (err) reject(err);
                resolve(rows.map(row => ({ ...row, attachments: JSON.parse(row.attachments || '[]') })));
            });
        });
        const employeesData = await new Promise((resolve, reject) => {
            db.all("SELECT * FROM employees", [], (err, rows) => {
                if (err) reject(err);
                resolve(rows);
            });
        });
        tasks = tasksData; // განვაახლოთ გლობალური tasks ცვლადი
        employees = employeesData; // განვაახლოთ გლობალური employees ცვლადი
        res.json({ employees: employeesData, tasks: tasksData });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// API: ნოტიფიკაციების მიღება და დამატება
app.get('/api/notifications', (req, res) => {
    res.json(notifications);
});

app.post('/api/notifications', (req, res) => {
    const { text } = req.body;
    const date = new Date().toLocaleString('ka-GE');
    db.run("INSERT INTO notifications (text, date, read) VALUES (?, ?, ?)", [text, date, 0], function(err) {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        // განვაახლოთ გლობალური notifications ცვლადი
        db.all("SELECT * FROM notifications", [], (err, rows) => {
            if (!err) notifications = rows;
        });
        res.status(201).json({ id: this.lastID });
    });
});

// API: ნოტიფიკაციების ისტორიის გასუფთავება
app.post('/api/notifications/clear', (req, res) => {
    db.run("DELETE FROM notifications", [], function(err) {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        notifications = []; // განვაახლოთ გლობალური notifications ცვლადი
        res.send("ისტორია გასუფთავდა");
    });
});

// API: თანამშრომლის დამატება
app.post('/api/add_employee', (req, res) => {
    const { name, position } = req.body;
    db.run("INSERT INTO employees (name, position) VALUES (?, ?)", [name, position], function(err) {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        // განვაახლოთ გლობალური employees ცვლადი
        db.all("SELECT * FROM employees", [], (err, rows) => {
            if (!err) employees = rows;
        });
        res.status(201).json({ id: this.lastID });
    });
});

// API: დავალების დამატება
app.post('/api/add_task', upload.array('files'), (req, res) => {
    const files = req.files ? req.files.map(f => ({ name: f.originalname, path: f.path, filename: f.filename })) : [];
    const newTask = {
        title: req.body.title,
        deadline: req.body.deadline,
        assignee: req.body.assignee,
        priority: req.body.priority || 'Medium', // Default to Medium if not provided
        client: req.body.client || '',
        requirements: req.body.requirements || '',
        comment: req.body.comment || '',
        status: 'Pending',
        attachments: JSON.stringify(files),
        subtasks: req.body.subtasks || '[]'
    };
    db.run(`INSERT INTO tasks (title, deadline, assignee, priority, client, requirements, comment, status, attachments, subtasks) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [newTask.title, newTask.deadline, newTask.assignee, newTask.priority, newTask.client, newTask.requirements, newTask.comment, newTask.status, newTask.attachments, newTask.subtasks],
        function(err) {
            if (err) {
                return res.status(500).json({ error: err.message });
            }
            logActivity(this.lastID, "შექმნა", "დავალება წარმატებით დაემატა სისტემაში");
            notifyClients();
            res.status(201).json({ id: this.lastID });
        }
    );
});

// API: სტატუსის შეცვლა
app.get('/api/mark_done/:id', (req, res) => {
    const id = parseInt(req.params.id);
    db.run("UPDATE tasks SET status = 'Done' WHERE id = ?", [id], function(err) {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        if (this.changes > 0) {
            logActivity(id, "სტატუსის შეცვლა", "სტატუსი შეიცვალა: შესრულებული");
            notifyClients();
            res.send("სტატუსი განახლდა");
        } else {
            res.status(404).send("დავალება ვერ მოიძებნა");
        }
    });
});

// API: სტატუსის დაბრუნება (Undone)
app.get('/api/mark_pending/:id', (req, res) => {
    const id = parseInt(req.params.id);
    db.run("UPDATE tasks SET status = 'Pending' WHERE id = ?", [id], function(err) {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        if (this.changes > 0) {
            logActivity(id, "სტატუსის შეცვლა", "სტატუსი შეიცვალა: მიმდინარე");
            notifyClients();
            res.send("სტატუსი განახლდა");
        } else {
            res.status(404).send("დავალება ვერ მოიძებნა");
        }
    });
});
// API: დავალების წაშლა
app.get('/api/delete_task/:id', (req, res) => {
    const id = parseInt(req.params.id);
    db.run("DELETE FROM tasks WHERE id = ?", [id], function(err) {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        if (this.changes > 0) {
            notifyClients();
            res.send("დავალება წაიშალა");
        } else {
            res.status(404).send("დავალება ვერ მოიძებნა");
        }
    });
});

// API: დავალების რედაქტირება
app.post('/api/edit_task/:id', upload.array('files'), (req, res) => {
    const id = parseInt(req.params.id);
    const newFiles = req.files ? req.files.map(f => ({ name: f.originalname, path: f.path, filename: f.filename })) : [];

    db.get("SELECT attachments FROM tasks WHERE id = ?", [id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).send("დავალება ვერ მოიძებნა");

        let existingAttachments = JSON.parse(row.attachments || '[]');
        if (newFiles.length > 0) {
            existingAttachments = [...existingAttachments, ...newFiles];
        }

        const { title, deadline, assignee, priority, client, requirements, comment, reminderTime, subtasks } = req.body;
        db.run(`UPDATE tasks SET 
            title = ?, deadline = ?, assignee = ?, priority = ?, client = ?, 
            requirements = ?, comment = ?, reminderTime = ?, attachments = ?, subtasks = ?
            WHERE id = ?`,
            [title, deadline, assignee, priority, client, requirements, comment, reminderTime || null, JSON.stringify(existingAttachments), subtasks || '[]', id],
            function(err) {
                if (err) {
                    return res.status(500).json({ error: err.message });
                }
                if (this.changes > 0) {
                    logActivity(id, "რედაქტირება", "დავალების მონაცემები განახლდა");
                    notifyClients();
                    res.send("დავალება განახლდა");
                } else {
                    res.status(404).send("დავალება ვერ მოიძებნა");
                }
            }
        );
    });
});

// API: დავალების ისტორიის მიღება
app.get('/api/tasks/:id/activity', (req, res) => {
    const id = parseInt(req.params.id);
    db.all("SELECT *, datetime(timestamp, 'localtime') as local_time FROM activity_log WHERE task_id = ? ORDER BY timestamp DESC", [id], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// API: ფაილების ავტომატური დახარისხება ფორმატების მიხედვით
app.post('/api/organize_files', async (req, res) => {
    const targetDir = __dirname;
    const coreFiles = [
        'server.js', 'package.json', 'package-lock.json', '.env', 
        'run_me.bat', 'data.json', 'asana_lite.db', 'script.js', 
        'style.css', 'index.html', 'kanban.html', 'stats.html', 
        'export.html', 'calendar.html', 'login.html', 'organize.js'
    ];
    const coreFolders = ['node_modules', 'uploads', '.git'];

    try {
        const items = await fs.promises.readdir(targetDir);
        let movedCount = 0;

        for (const item of items) {
            const fullPath = path.join(targetDir, item);
            const stat = await fs.promises.stat(fullPath);

            if (stat.isFile() && !coreFiles.includes(item)) {
                const ext = path.extname(item).slice(1).toLowerCase() || 'others';
                const destDir = path.join(targetDir, ext);

                if (!fs.existsSync(destDir)) {
                    await fs.promises.mkdir(destDir);
                }

                const destPath = path.join(destDir, item);
                await fs.promises.rename(fullPath, destPath);
                movedCount++;
            }
        }
        res.json({ success: true, message: `წარმატებით დახარისხდა ${movedCount} ფაილი.` });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: "დახარისხებისას მოხდა შეცდომა." });
    }
});

// API: ჯგუფური წაშლა
app.post('/api/tasks/bulk_delete', (req, res) => {
    const { ids } = req.body;
    if (!ids || !Array.isArray(ids)) return res.status(400).send("Invalid IDs");

    const placeholders = ids.map(() => '?').join(',');
    db.run(`DELETE FROM tasks WHERE id IN (${placeholders})`, ids, function(err) {
        if (err) return res.status(500).json({ error: err.message });
        notifyClients();
        res.send("დავალებები წაიშალა");
    });
});

// API: ჯგუფური სტატუსის შეცვლა
app.post('/api/tasks/bulk_status', (req, res) => {
    const { ids, status } = req.body;
    if (!ids || !Array.isArray(ids)) return res.status(400).send("Invalid IDs");

    const placeholders = ids.map(() => '?').join(',');
    db.run(`UPDATE tasks SET status = ? WHERE id IN (${placeholders})`, [status, ...ids], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        notifyClients();
        res.send("სტატუსები განახლდა");
    });
});

// API: მონაცემების ექსპორტი Excel-ში
app.get('/api/export', async (req, res) => {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('დავალებები');

    // სვეტების განსაზღვრა (ზუსტად იმ მიმდევრობით, როგორც UI-შია + ფოტო)
    worksheet.columns = [
        { header: 'ID', key: 'id', width: 8 },
        { header: 'დავალება', key: 'title', width: 35 },
        { header: 'პრიორიტეტი', key: 'priority', width: 12 },
        { header: 'დამკვეთი', key: 'client', width: 25 },
        { header: 'საჭიროებები', key: 'requirements', width: 35 },
        { header: 'კომენტარი', key: 'comment', width: 35 },
        { header: 'დედლაინი', key: 'deadline', width: 15 },
        { header: 'შემსრულებელი', key: 'assignee', width: 20 },
        { header: 'სტატუსი', key: 'status', width: 15 },
        { header: 'ფოტო', key: 'photo', width: 25 }
    ];

    // სათაურების სტილი
    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };

    db.all("SELECT * FROM tasks", [], async (err, rows) => {
        if (err) return res.status(500).send(err.message);

        for (const row of rows) {
            const excelRow = worksheet.addRow({
                id: row.id,
                title: row.title,
                priority: row.priority,
                client: row.client,
                requirements: row.requirements,
                comment: row.comment,
                deadline: row.deadline,
                assignee: row.assignee,
                status: row.status
            });

            excelRow.alignment = { vertical: 'middle', wrapText: true };

            // ფაილების დამუშავება (თუ არის ფოტო, ჩავსვათ ექსელში)
            const attachments = JSON.parse(row.attachments || '[]');
            const imageFile = attachments.find(f => /\.(jpg|jpeg|png|gif)$/i.test(f.name));

            if (imageFile) {
                const imagePath = path.join(UPLOADS_DIR, imageFile.filename);
                if (fs.existsSync(imagePath)) {
                    const ext = imageFile.filename.split('.').pop().toLowerCase();
                    const imageId = workbook.addImage({
                        filename: imagePath,
                        extension: ext === 'jpg' ? 'jpeg' : ext,
                    });
                    
                    worksheet.getRow(excelRow.number).height = 90; // სიმაღლის გაზრდა ფოტოსთვის
                    worksheet.addImage(imageId, {
                        tl: { col: 9.1, row: excelRow.number - 0.9 },
                        ext: { width: 110, height: 110 }
                    });
                }
            }
        }

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename=asana_tasks_export.xlsx');

        await workbook.xlsx.write(res);
        res.end();
    });
});

function startServer(port) {
    server.listen(port, () => {
        console.log('=========================================');
        console.log(`🚀 სერვერი მზად არის! გახსენით: http://localhost:${port}`);
        console.log('=========================================');
    }).on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.log(`⚠️  პორტი ${port} დაკავებულია, ვცდი ${port + 1}-ს...`);
            startServer(port + 1);
        } else {
            console.error('❌ მოხდა გაუთვალისწინებელი შეცდომა:', err);
        }
    });
}
startServer(PORT);