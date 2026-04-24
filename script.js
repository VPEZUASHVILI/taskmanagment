let currentTasks = [];
let tasksChart = null;
let viewMode = 'table'; // 'table' ან 'kanban'
let notificationAlreadyShown = false; // თავიდან ავიცილოთ შეტყობინებების სპამი
let selectedTaskId = null; // მონიშნული დავალების ID
let setReminderModalInstance = null; // შეხსენების მოდალის ინსტანცია
let specificReminderInterval = null; // კონკრეტული შეხსენების ტაიმერი

// რეალურ დროში სინქრონიზაციის ინიციალიზაცია
const socket = typeof io !== 'undefined' ? io() : null;
if (socket) {
    socket.on('tasksUpdated', () => {
        console.log('მონაცემები განახლდა რეალურ დროში...');
        loadData();
    });
}

// საწყისი მონაცემების წამოღება სერვერიდან
async function loadData() {
    const response = await fetch('/api/data');
    const data = await response.json();
    currentTasks = data.tasks;
    renderEmployees(data.employees);

    const page = document.body.dataset.page;
    if (page === 'kanban') {
        renderKanban(currentTasks);
    } else if (page === 'stats') {
        updateStatistics(data);
    } else if (page === 'calendar') {
        renderCalendar(currentTasks);
    } else {
        filterTasks(); // მთავარი გვერდისთვის (Table)
    }

    checkImpendingDeadlines(data.tasks);
    loadNotificationHistory();
    requestNotificationPermission();
    checkSpecificReminders();
    populateReminderHours();
    loadUserInfo();
}

// ხედის გადართვა
function toggleView() {
    viewMode = viewMode === 'table' ? 'kanban' : 'table';
    document.getElementById('tableView').classList.toggle('d-none', viewMode === 'kanban');
    document.getElementById('kanbanView').classList.toggle('d-none', viewMode === 'table');
    loadData();
}

// დავალებების გაფილტვრა სტატუსის მიხედვით
function filterTasks() {
    const statusEl = document.getElementById('statusFilter');
    const priorityEl = document.getElementById('priorityFilter');
    const searchEl = document.getElementById('searchInput');

    // თუ ელემენტები არ არსებობს (მაგ. სხვა გვერდზე), ნუ გავაგრძელებთ
    if (!statusEl || !priorityEl || !searchEl) return;

    const statusValue = statusEl.value;
    const priorityValue = priorityEl.value;
    const searchText = searchEl.value.toLowerCase();

    let filteredTasks = currentTasks;

    // ფილტრაცია სტატუსით
    if (statusValue !== 'all') {
        filteredTasks = filteredTasks.filter(task => task.status === statusValue);
    }

    // ფილტრაცია პრიორიტეტით
    if (priorityValue !== 'all') {
        filteredTasks = filteredTasks.filter(task => (task.priority || 'Medium') === priorityValue);
    }

    // ჭკვიანი ძებნა (დამკვეთი + სათაური)
    if (searchText) {
        filteredTasks = filteredTasks.filter(task => 
            (task.client || "").toLowerCase().includes(searchText) || 
            (task.title || "").toLowerCase().includes(searchText)
        );
    }

    // დავალებების დახარისხება (პრიორიტეტი ჯერ, მერე დედლაინი)
    const priorityWeight = { 'High': 3, 'Medium': 2, 'Low': 1 };
    filteredTasks.sort((a, b) => {
        const pDiff = (priorityWeight[b.priority] || 2) - (priorityWeight[a.priority] || 2);
        if (pDiff !== 0) return pDiff;
        return new Date(a.deadline) - new Date(b.deadline);
    });

    if (viewMode === 'table') {
        renderTasks(filteredTasks);
    } else {
        renderKanban(filteredTasks);
    }
}

// ბრაუზერის ნებართვის მოთხოვნა
function requestNotificationPermission() {
    if ("Notification" in window) {
        if (Notification.permission !== "granted" && Notification.permission !== "denied") {
            Notification.requestPermission();
        }
    }
}

// ნოტიფიკაციების ისტორიის ჩატვირთვა
async function loadNotificationHistory() {
    const response = await fetch('/api/notifications');
    const history = await response.json();
    renderNotificationHistory(history);
}

function renderNotificationHistory(history) {
    const list = document.getElementById('notificationList');
    const badge = document.getElementById('notificationBadge');

    if (!list) return;

    list.innerHTML = history.length === 0 ? '<div class="p-3 text-center text-muted">ისტორია ცარიელია</div>' : '';
    
    history.reverse().forEach(note => {
        list.innerHTML += `
            <div class="list-group-item">
                <div class="small text-primary">${note.date}</div>
                <div class="small">${note.text}</div>
            </div>
        `;
    });

    if (badge) {
        badge.textContent = history.length;
        badge.classList.toggle('d-none', history.length === 0);
    }
}

// ნოტიფიკაციების ისტორიის გასუფთავება
async function clearNotifications() {
    if (confirm('ნამდვილად გსურთ შეტყობინებების ისტორიის სრულად გასუფთავება?')) {
        await fetch('/api/notifications/clear', { method: 'POST' });
        loadNotificationHistory();
    }
}

// საათების სიის გენერირება (00:00 - 23:00)
function populateReminderHours() {
    const select = document.getElementById('reminderHour');
    if (!select) return;
    select.innerHTML = '';
    for (let i = 0; i < 24; i++) {
        const hour = String(i).padStart(2, '0') + ':00';
        const option = document.createElement('option');
        option.value = hour;
        option.textContent = hour;
        select.appendChild(option);
    }
}

// მარჯვენა ღილაკით დაწკაპება ID-ზე
function handleIdRightClick(event, id) {
    event.preventDefault(); // ბრაუზერის სტანდარტული მენიუს გათიშვა
    selectedTaskId = parseInt(id);
    
    const task = currentTasks.find(t => t.id === selectedTaskId);
    const dateInput = document.getElementById('reminderDate');
    const hourInput = document.getElementById('reminderHour');

    if (task && task.reminderTime) {
        const [date, hour] = task.reminderTime.split('T');
        dateInput.value = date;
        hourInput.value = hour;
    } else {
        dateInput.value = new Date().toISOString().split('T')[0];
        hourInput.value = '09:00';
    }
    
    if (!setReminderModalInstance) {
        setReminderModalInstance = new bootstrap.Modal(document.getElementById('setReminderModal'));
    }
    setReminderModalInstance.show();
}

// შეხსენების დროის შენახვა
async function saveTaskReminder() {
    const date = document.getElementById('reminderDate').value;
    const hour = document.getElementById('reminderHour').value;
    
    if (!selectedTaskId || !date || !hour) return;

    const reminderTime = `${date}T${hour}`;
    const task = currentTasks.find(t => t.id === selectedTaskId);
    
    await fetch(`/api/edit_task/${selectedTaskId}`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ ...task, reminderTime: reminderTime })
    });

    if (setReminderModalInstance) {
        setReminderModalInstance.hide();
    }
    loadData();
}

function playNotificationSound() {
    const audio = new Audio('https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3');
    audio.play().catch(e => console.log("ხმის დაკვრა ვერ მოხერხდა მომხმარებლის ინტერაქციის გარეშე."));
}

// კონკრეტული შეხსენებების შემოწმება (ყოველ წუთს)
function checkSpecificReminders() {
    if (specificReminderInterval) return; // თუ უკვე გაშვებულია, აღარ დავამატოთ
    
    // თუ გვერდზე არ არის საჭირო ელემენტები, ნუ გავუშვებთ შემოწმებას
    if (!document.getElementById('notificationArea') && !document.body.dataset.page) return;

    specificReminderInterval = setInterval(() => {
        const now = new Date();
        
        // ფორმატირება ლოკალური დროის მიხედვით (YYYY-MM-DDTHH:00)
        // ვინაიდან საათებს ვირჩევთ :00 ფორმატში, შედარებისთვის წუთებს ვაიგნორებთ
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        const hours = String(now.getHours()).padStart(2, '0');
        const nowStr = `${year}-${month}-${day}T${hours}:00`;

        currentTasks.forEach(task => {
            if (task.reminderTime === nowStr && task.status === 'Pending') {
                playNotificationSound();
                if (Notification.permission === "granted") {
                    new Notification("დროა! დავალების შეხსენება", {
                        body: task.title,
                        icon: "https://cdn-icons-png.flaticon.com/512/179/179386.png"
                    });
                }
                // ვაშორებთ დროს რომ აღარ განმეორდეს
                task.reminderTime = null;
                fetch(`/api/edit_task/${task.id}`, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify(task)
                });
            }
        });
    }, 60000); // შემოწმება 60 წამში ერთხელ
}

// დედლაინის შეტყობინებების შემოწმება (1 დღით ადრე)
async function checkImpendingDeadlines(tasks) {
    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().split('T')[0];

    const urgentTasks = tasks.filter(t => t.status === 'Pending' && t.deadline === tomorrowStr);
    const notificationArea = document.getElementById('notificationArea');
    
    if (!notificationArea) return;

    notificationArea.innerHTML = '';

    urgentTasks.forEach(task => {
        // ვამოწმებთ, ხომ არ გვაქვს უკვე ეს შეტყობინება ისტორიაში დღეს
        const noteText = `დავალება: "${task.title}" სრულდება ხვალ!`;
        
        // ვაგზავნით სერვერზე შესანახად
        fetch('/api/notifications', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ text: noteText })
        });

        const alert = document.createElement('div');
        alert.className = 'alert alert-warning alert-dismissible fade show shadow-sm border-start border-4 border-warning stats-fade-in';
        alert.role = 'alert';
        alert.innerHTML = `
            <div class="d-flex align-items-center">
                <i class="bi bi-exclamation-triangle-fill me-2 fs-5"></i>
                <div><strong>ყურადღება!</strong> დავალება: "<strong>${task.title}</strong>" სრულდება ხვალ (${task.deadline}).</div>
            </div>
            <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>
        `;
        notificationArea.appendChild(alert);
    });

    // ბრაუზერის სისტემური შეტყობინება
    if (urgentTasks.length > 0 && Notification.permission === "granted" && !notificationAlreadyShown) {
        new Notification("Asana Lite: მოახლოებული დედლაინი", {
            body: `თქვენ გაქვთ ${urgentTasks.length} დავალება, რომელიც ხვალ სრულდება!`,
            icon: "https://cdn-icons-png.flaticon.com/512/179/179386.png" // საილუსტრაციო აიქონი
        });
        notificationAlreadyShown = true; // ვაჩვენებთ მხოლოდ ერთხელ სესიის განმავლობაში
    }
}

// კანბანის დაფის დახატვა
function renderKanban(tasks) {
    const pendingCol = document.getElementById('kanban-pending');
    const doneCol = document.getElementById('kanban-done');
    pendingCol.innerHTML = '';
    doneCol.innerHTML = '';
    let pendingHtml = '', doneHtml = '';

    tasks.forEach(task => {
        const cardHtml = `
            <div class="kanban-card card mb-3 shadow-sm border-start border-4 priority-${(task.priority || 'Medium').toLowerCase()}" data-id="${task.id}">
                <div class="card-body p-2">
                <div class="d-flex justify-content-between align-items-start mb-2">
                    <h6 class="card-title mb-0 fw-bold text-truncate" style="max-width: 150px;">${task.title}</h6>
                    <span class="badge bg-secondary" style="font-size: 0.6em;">ID: ${task.id}</span>
                </div>
                <p class="small text-muted mb-1"><b>დამკვეთი:</b> ${task.client || '-'}</p>
                <p class="small text-muted mb-1"><b>ვადა:</b> ${task.deadline}</p>
                ${task.comment ? `<p class="small border-top pt-1 mt-1 mb-2 text-secondary" title="${task.comment}"><i>${truncateText(task.comment, 45)}</i></p>` : ''}
                <div class="d-flex justify-content-end border-top pt-1">
                    <button onclick="openEditModal(${task.id})" class="btn btn-sm btn-link p-0 text-info me-2"><i class="bi bi-pencil"></i></button>
                    <button onclick="deleteTask(${task.id})" class="btn btn-sm btn-link p-0 text-danger"><i class="bi bi-trash"></i></button>
                </div>
            </div>
        `;
        if (task.status === 'Done') doneHtml += cardHtml;
        else pendingHtml += cardHtml;
    });

    pendingCol.innerHTML = pendingHtml;
    doneCol.innerHTML = doneHtml;

    initSortable();
}

// SortableJS ინიციალიზაცია
function initSortable() {
    const options = {
        group: 'kanban',
        animation: 150,
        draggable: '.kanban-card',
        onEnd: async function (evt) {
            const taskId = evt.item.dataset.id;
            const newStatus = evt.to.id === 'kanban-done' ? 'mark_done' : 'mark_pending';
            await fetch(`/api/${newStatus}/${taskId}`);
            loadData();
        }
    };

    new Sortable(document.getElementById('kanban-pending'), options);
    new Sortable(document.getElementById('kanban-done'), options);
}
// სტატისტიკის განახლება
function updateStatistics(data) {
    const totalTasks = data.tasks.length;
    const doneTasks = data.tasks.filter(t => t.status === 'Done').length;
    const pendingTasks = totalTasks - doneTasks;
    const totalEmployees = data.employees.length;

    const elTotal = document.getElementById('statTotalTasks');
    const elDone = document.getElementById('statDoneTasks');
    const elPending = document.getElementById('statPendingTasks');
    const elEmps = document.getElementById('statTotalEmployees');

    if (elTotal) elTotal.textContent = totalTasks;
    if (elDone) elDone.textContent = doneTasks;
    if (elPending) elPending.textContent = pendingTasks;
    if (elEmps) elEmps.textContent = totalEmployees;

    renderChart(doneTasks, pendingTasks);
}

// დიაგრამის დახატვა/განახლება
function renderChart(done, pending) {
    const chartEl = document.getElementById('tasksChart');
    if (!chartEl) return;
    const ctx = chartEl.getContext('2d');
    
    if (tasksChart) {
        // თუ დიაგრამა უკვე არსებობს, უბრალოდ განვაახლოთ მონაცემები
        tasksChart.data.datasets[0].data = [done, pending];
        tasksChart.update();
    } else {
        // ახალი დიაგრამის შექმნა
        tasksChart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: ['შესრულებული', 'მიმდინარე'],
                datasets: [{
                    label: 'დავალებების რაოდენობა',
                    data: [done, pending],
                    backgroundColor: ['#198754', '#ffc107'],
                    borderWidth: 1
                }]
            },
            options: {
                responsive: true,
                plugins: {
                    legend: { display: false }
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        ticks: { stepSize: 1 }
                    }
                }
            }
        });
    }
}

// სტატისტიკის სექციის გადართვა (ჩვენება/დამალვა)
function toggleStatistics() {
    const statsSection = document.getElementById('statisticsSection');
    const btn = document.getElementById('toggleStatsBtn');
    
    if (statsSection.classList.contains('d-none')) {
        statsSection.classList.remove('d-none');
        statsSection.classList.add('stats-fade-in');
        btn.classList.add('active');
        loadData(); // მონაცემების და დიაგრამის განახლება გამოჩენისას
    } else {
        statsSection.classList.add('d-none');
        statsSection.classList.remove('stats-fade-in');
        btn.classList.remove('active');
    }
}

// ტექსტის შეკვეცის ფუნქცია
function truncateText(text, limit = 40) {
    if (!text || text.length <= limit) return text;
    return text.substring(0, limit) + "...";
}

// ფუნქცია ტექსტის გასანათებლად ძებნისას
function highlightMatch(text, query) {
    if (!query || !text) return text;
    const regex = new RegExp(`(${query})`, 'gi');
    return text.toString().replace(regex, '<mark class="highlight">$1</mark>');
}

// თანამშრომლების ჩამონათვალის განახლება სელექტში
function renderEmployees(employees) {
    const select = document.getElementById('taskAssignee');
    const editSelect = document.getElementById('editTaskAssignee');
    
    let options = '<option value="">თანამშრომელი</option>';
    
    employees.forEach(emp => {
        options += `<option value="${emp.name}">${emp.name}</option>`;
    });
    
    if (select) select.innerHTML = options;
    if (editSelect) editSelect.innerHTML = options;
}

// დავალებების ცხრილის დახატვა
function renderTasks(tasks) {
    const tbody = document.getElementById('taskTableBody');
    if (!tbody) return;

    const searchQuery = document.getElementById('searchInput') ? document.getElementById('searchInput').value : '';
    let rowsHtml = '';
    const today = new Date().toISOString().split('T')[0]; // მიმდინარე თარიღი YYYY-MM-DD ფორმატში

    if (!tasks || tasks.length === 0) {
        tbody.innerHTML = '<tr><td colspan="10" class="text-center text-muted p-4">მონაცემები არ მოიძებნა</td></tr>';
        return;
    }

    tasks.forEach(task => {
        try {
            const priority = task.priority || 'Medium';
            const attachments = Array.isArray(task.attachments) ? task.attachments : [];
            const isOverdue = task.status === 'Pending' && task.deadline && task.deadline < today;
            const isDueToday = task.status === 'Pending' && task.deadline === today;
            const isSelected = selectedTaskId === task.id ? 'selected-task-row' : '';
            
            // ჩეკლისტის გათვლა
            const subtasks = JSON.parse(task.subtasks || '[]');
            const completedSub = subtasks.filter(s => s.done).length;
            const totalSub = subtasks.length;
            const progressPercent = totalSub > 0 ? Math.round((completedSub / totalSub) * 100) : 0;
            const progressHtml = totalSub > 0 ? `
                <div class="progress mt-1" style="height: 4px; width: 80px;" title="${completedSub}/${totalSub} შესრულებულია">
                    <div class="progress-bar bg-success" role="progressbar" style="width: ${progressPercent}%"></div>
                </div>` : '';

            // ფერების პალიტრა
            const priorityColor = { 'High': '#ef4444', 'Medium': '#f59e0b', 'Low': '#0ea5e9' }[priority] || '#94a3b8';
            
            const badgeClass = task.status === 'Done' 
                ? 'bg-success-subtle text-success border-success'
                : (isOverdue || isDueToday ? 'bg-danger-subtle text-danger border-danger' : 'bg-warning-subtle text-warning border-warning');
            
            const displayStatusText = task.status === 'Done' 
                ? 'შესრულებული' 
                : (isOverdue ? 'ვადაგადაცილებული' : (isDueToday ? 'დღეს სრულდება' : 'მიმდინარე'));
            
            const assigneeDisplay = task.assignee || 'არ არის მინიჭებული';
            
            const reminderIcon = task.reminderTime ? `<i class="bi bi-alarm-fill ms-1 text-warning" title="შეხსენება: ${task.reminderTime.replace('T', ' ')}"></i>` : '';
            const attachmentIcons = attachments.length > 0 ? `<span class="ms-1 text-muted small" title="${attachments.map(f => f.name).join(', ')}"><i class="bi bi-paperclip"></i>${attachments.length}</span>` : '';

            const displayTitle = highlightMatch(truncateText(task.title || '', 30), searchQuery);
            const displayClient = task.client ? highlightMatch(truncateText(task.client, 20), searchQuery) : '<span class="text-muted" style="font-size: 0.65rem;">-</span>';
            const displayRequirements = task.requirements ? highlightMatch(truncateText(task.requirements, 20), searchQuery) : '<span class="text-muted" style="font-size: 0.65rem;">-</span>';
            const displayComment = task.comment ? `<span title="${task.comment.replace(/"/g, '&quot;')}">${truncateText(task.comment, 20)}</span>` : '<span class="text-muted" style="font-size: 0.65rem;">-</span>';

            rowsHtml += `
                <tr class="bg-white shadow-sm rounded ${task.status === 'Done' ? 'opacity-75' : ''} ${isSelected}" style="border-left: 3px solid ${priorityColor} !important; font-size: 0.75rem;">
                    <td class="ps-3"><input type="checkbox" class="form-check-input task-checkbox" value="${task.id}" onchange="updateBulkSelection()"></td>
                    <td oncontextmenu="handleIdRightClick(event, '${task.id}')" style="cursor: help; font-size: 0.7rem;" class="text-muted fw-bold">#${task.id}${reminderIcon}</td>
                    <td class="py-1">
                        <div class="fw-bold text-dark d-flex align-items-center" style="font-size: 0.8rem; line-height: 1.2;">
                            ${displayTitle}
                            ${attachmentIcons}
                        </div>
                        ${progressHtml}
                        <div class="text-muted" style="font-size: 0.6rem;">${priority}</div>
                    </td>
                    <td class="text-muted" style="font-size: 0.7rem;"><i class="bi bi-building me-1"></i>${displayClient}</td>
                    <td class="text-muted" style="font-size: 0.7rem;">${displayRequirements}</td>
                    <td class="text-muted" style="font-size: 0.7rem;">${displayComment}</td>
                    <td class="${(isOverdue || isDueToday) ? 'text-danger fw-bold' : 'text-muted'}" style="font-size: 0.7rem;"><i class="bi bi-calendar2-check me-1"></i>${task.deadline || '-'} ${isDueToday ? '⏳' : ''}</td>
                    <td class="fw-medium text-dark" style="font-size: 0.7rem;"><i class="bi bi-person me-1"></i>${assigneeDisplay}</td>
                    <td class="text-center"><span class="badge rounded-pill border ${badgeClass}" style="font-size: 0.6rem; padding: 0.25em 0.5em;">${displayStatusText}</span></td>
                    <td class="text-end pe-3" style="white-space: nowrap;">
                        <div class="d-flex justify-content-end gap-1">
                            ${task.status !== 'Done' 
                                ? `<button onclick="event.stopPropagation(); markDone(${task.id})" class="btn btn-sm btn-light text-success shadow-sm" title="შესრულება"><i class="bi bi-check-lg"></i></button>` 
                                : `<button onclick="event.stopPropagation(); markPending(${task.id})" class="btn btn-sm btn-light text-warning shadow-sm" title="დაბრუნება"><i class="bi bi-arrow-counterclockwise"></i></button>`}
                            <button onclick="event.stopPropagation(); openEditModal(${task.id})" class="btn btn-sm btn-light text-primary shadow-sm" title="რედაქტირება"><i class="bi bi-pencil-square"></i></button>
                            <button onclick="event.stopPropagation(); viewHistory(${task.id})" class="btn btn-sm btn-light text-secondary shadow-sm" title="ისტორია"><i class="bi bi-clock-history"></i></button>
                            <button onclick="event.stopPropagation(); deleteTask(${task.id})" class="btn btn-sm btn-light text-danger shadow-sm" title="წაშლა"><i class="bi bi-trash3"></i></button>
                        </div>
                    </td>
                </tr>
            `;
        } catch (err) {
            console.error("შეცდომა დავალების ხატვისას:", err, task);
        }
    });
    tbody.innerHTML = rowsHtml;
}

// ქვე-დავალებების ინპუტების მართვა
function addSubtaskInput(containerId, text = '', done = false) {
    const container = document.getElementById(containerId);
    const div = document.createElement('div');
    div.className = 'input-group input-group-sm mb-1 subtask-item';
    div.innerHTML = `
        <div class="input-group-text">
            <input class="form-check-input mt-0" type="checkbox" ${done ? 'checked' : ''}>
        </div>
        <input type="text" class="form-control subtask-text" value="${text}" placeholder="ქვე-დავალება...">
        <button class="btn btn-outline-danger" type="button" onclick="this.parentElement.remove()"><i class="bi bi-x"></i></button>
    `;
    container.appendChild(div);
}

function getSubtasksFromContainer(containerId) {
    const items = document.querySelectorAll(`#${containerId} .subtask-item`);
    return Array.from(items).map(item => ({
        text: item.querySelector('.subtask-text').value,
        done: item.querySelector('.form-check-input').checked
    })).filter(s => s.text.trim() !== '');
}

document.getElementById('taskForm').onsubmit = async (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    // სხვა ველების დამატება (რადგან ID-ები გვაქვს და არა Name ატრიბუტები)
    formData.append('title', document.getElementById('taskTitle').value);
    formData.append('deadline', document.getElementById('taskDeadline').value);
    formData.append('assignee', document.getElementById('taskAssignee').value);
    formData.append('priority', document.getElementById('taskPriority').value);
    formData.append('client', document.getElementById('taskClient').value);
    formData.append('requirements', document.getElementById('taskRequirements').value);
    formData.append('comment', document.getElementById('taskComment').value);
    formData.append('subtasks', JSON.stringify(getSubtasksFromContainer('subtaskContainer')));

    const fileInput = document.getElementById('taskFiles');
    if (fileInput.files.length > 0) {
        for (let i = 0; i < fileInput.files.length; i++) {
            formData.append('files', fileInput.files[i]);
        }
    }
    
    await fetch('/api/add_task', {
        method: 'POST',
        body: formData // ავტომატურად აყენებს multipart/form-data-ს
    });
    document.getElementById('taskForm').reset();
    document.getElementById('subtaskContainer').innerHTML = '';
    bootstrap.Modal.getInstance(document.getElementById('addTaskModal')).hide();
    loadData();
};

function openEditModal(id) {
    const task = currentTasks.find(t => t.id === id);
    if (!task) return;
    
    document.getElementById('editTaskId').value = task.id;
    document.getElementById('editTaskTitle').value = task.title;
    document.getElementById('editTaskDeadline').value = task.deadline;
    document.getElementById('editTaskPriority').value = task.priority;
    document.getElementById('editTaskClient').value = task.client;
    document.getElementById('editTaskRequirements').value = task.requirements;
    document.getElementById('editTaskComment').value = task.comment;
    document.getElementById('editTaskAssignee').value = task.assignee;
    
    const container = document.getElementById('editSubtaskContainer');
    container.innerHTML = '';
    const subtasks = JSON.parse(task.subtasks || '[]');
    subtasks.forEach(s => addSubtaskInput('editSubtaskContainer', s.text, s.done));

    new bootstrap.Modal(document.getElementById('editTaskModal')).show();
}

document.getElementById('editTaskForm').onsubmit = async (e) => {
    e.preventDefault();
    const id = document.getElementById('editTaskId').value;
        const formData = new FormData(e.target);
        formData.append('title', document.getElementById('editTaskTitle').value);
        formData.append('deadline', document.getElementById('editTaskDeadline').value);
        formData.append('assignee', document.getElementById('editTaskAssignee').value);
        formData.append('priority', document.getElementById('editTaskPriority').value);
        formData.append('client', document.getElementById('editTaskClient').value);
        formData.append('requirements', document.getElementById('editTaskRequirements').value);
        formData.append('comment', document.getElementById('editTaskComment').value);
        formData.append('subtasks', JSON.stringify(getSubtasksFromContainer('editSubtaskContainer')));

    const fileInput = document.getElementById('editTaskFiles');
    if (fileInput.files.length > 0) {
        for (let i = 0; i < fileInput.files.length; i++) {
            formData.append('files', fileInput.files[i]);
        }
    }

    await fetch(`/api/edit_task/${id}`, {
        method: 'POST',
        body: formData
    });
    bootstrap.Modal.getInstance(document.getElementById('editTaskModal')).hide();
    loadData();
};

async function markDone(id) {
    await fetch(`/api/mark_done/${id}`);
    
    // Confetti ეფექტი წარმატებისთვის
    confetti({
        particleCount: 150,
        spread: 70,
        origin: { y: 0.6 },
        colors: ['#6366f1', '#10b981', '#f59e0b']
    });

    loadData();
}

async function markPending(id) {
    await fetch(`/api/mark_pending/${id}`);
    loadData();
}

async function deleteTask(id) {
    if(confirm('წავშალოთ?')) {
        await fetch(`/api/delete_task/${id}`);
        loadData();
    }
}

async function syncOutlook() {
    window.location.href = '/auth/outlook';
}

// დავალების ისტორიის ჩვენება
async function viewHistory(taskId) {
    const response = await fetch(`/api/tasks/${taskId}/activity`);
    const logs = await response.json();
    
    const container = document.getElementById('activityTimeline');
    container.innerHTML = logs.length === 0 ? '<p class="text-muted small">ისტორია ვერ მოიძებნა</p>' : '';

    logs.forEach(log => {
        const date = new Date(log.local_time).toLocaleString('ka-GE', {
            month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
        });
        
        container.innerHTML += `
            <div class="mb-3 position-relative">
                <div class="position-absolute start-0 translate-middle-x bg-primary rounded-circle" style="width:10px; height:10px; left: -21px !important; top: 5px;"></div>
                <div class="small fw-bold text-dark">${log.action}</div>
                <div class="small text-muted">${log.details}</div>
                <div class="text-end" style="font-size: 0.7rem; color: #aaa;">${date}</div>
            </div>
        `;
    });

    new bootstrap.Modal(document.getElementById('taskHistoryModal')).show();
}

// Excel ექსპორტის ფუნქცია
function exportData() {
    window.location.href = '/api/export';
}

// გლობალური მუქი რეჟიმის გადართვა
function toggleDarkMode() {
    const html = document.documentElement;
    const isDark = html.getAttribute('data-bs-theme') === 'dark';
    const newTheme = isDark ? 'light' : 'dark';
    
    html.setAttribute('data-bs-theme', newTheme);
    localStorage.setItem('theme', newTheme);
    
    // გადამრთველის (Switch) მდგომარეობის სინქრონიზაცია
    document.getElementById('darkModeToggle').checked = (newTheme === 'dark');
}

// გვერდის ჩატვირთვისას თემის აღდგენა
(function initTheme() {
    const savedTheme = localStorage.getItem('theme') || 'light';
    document.documentElement.setAttribute('data-bs-theme', savedTheme);
    
    window.addEventListener('DOMContentLoaded', () => {
        const toggle = document.getElementById('darkModeToggle');
        if (toggle) toggle.checked = (savedTheme === 'dark');
    });
})();

// ჯგუფური მოქმედებების ფუნქციები
function toggleSelectAll(source) {
    const checkboxes = document.querySelectorAll('.task-checkbox');
    checkboxes.forEach(cb => cb.checked = source.checked);
    updateBulkSelection();
}

function updateBulkSelection() {
    const checkboxes = document.querySelectorAll('.task-checkbox:checked');
    const bar = document.getElementById('bulkActionsBar');
    const countSpan = document.getElementById('selectedCount');
    
    if (bar && countSpan) {
        if (checkboxes.length > 0) {
            bar.classList.remove('d-none');
            countSpan.textContent = `${checkboxes.length} მონიშნულია`;
        } else {
            bar.classList.add('d-none');
        }
    }
}

async function bulkMarkDone() {
    const ids = Array.from(document.querySelectorAll('.task-checkbox:checked')).map(cb => cb.value);
    if (ids.length === 0) return;
    
    await fetch('/api/tasks/bulk_status', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ ids, status: 'Done' })
    });
    
    clearSelection();
    loadData();
    confetti({ particleCount: 150, spread: 70, origin: { y: 0.6 } });
}

async function bulkDelete() {
    const ids = Array.from(document.querySelectorAll('.task-checkbox:checked')).map(cb => cb.value);
    if (ids.length === 0 || !confirm(`ნამდვილად გსურთ ${ids.length} დავალების წაშლა?`)) return;

    await fetch('/api/tasks/bulk_delete', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ ids })
    });

    clearSelection();
    loadData();
}

function clearSelection() {
    const selectAll = document.getElementById('selectAllTasks');
    if (selectAll) selectAll.checked = false;
    document.querySelectorAll('.task-checkbox').forEach(cb => cb.checked = false);
    updateBulkSelection();
}

// მომხმარებლის ინფორმაციის ჩატვირთვა
async function loadUserInfo() {
    const response = await fetch('/api/user/info');
    if (response.ok) {
        const user = await response.json();
        const avatarImg = document.getElementById('userAvatar');
        const userIcon = document.getElementById('userIcon');
        const nameInput = document.getElementById('newUsername');
        const userNameDisplay = document.getElementById('userNameDisplay');
        
        if (nameInput) nameInput.value = user.username;
        if (userNameDisplay) userNameDisplay.textContent = user.username;
        
        if (user.avatar && avatarImg && userIcon) {
            avatarImg.src = '/' + user.avatar.replace(/\\/g, '/');
            avatarImg.classList.remove('d-none');
            userIcon.classList.add('d-none');
        }
    }
}

// მომხმარებლის პარამეტრების შენახვა
if (document.getElementById('userSettingsForm')) {
    document.getElementById('userSettingsForm').onsubmit = async (e) => {
        e.preventDefault();
        
        const formData = new FormData();
        formData.append('newUsername', document.getElementById('newUsername').value);
        formData.append('oldPassword', document.getElementById('oldPassword').value);
        formData.append('newPassword', document.getElementById('newPassword').value);
        
        const avatarFile = document.getElementById('newAvatar').files[0];
        if (avatarFile) formData.append('avatar', avatarFile);

        const response = await fetch('/api/user/update', {
            method: 'POST',
            body: formData
        });

        if (response.ok) {
            alert('პროფილი წარმატებით განახლდა!');
            location.reload();
        } else {
            const err = await response.json();
            alert('შეცდომა: ' + err.error);
        }
    };
}

// Sidebar-ის გადამრთველი ფუნქცია
function toggleSidebar() {
    const sidebar = document.getElementById('sidebarColumn');
    const content = document.getElementById('contentColumn');
    
    if (!sidebar || !content) return;

    if (sidebar.classList.contains('d-none')) {
        sidebar.classList.remove('d-none');
        content.classList.replace('col-md-12', 'col-md-10');
        content.classList.replace('col-lg-12', 'col-lg-11');
    } else {
        sidebar.classList.add('d-none');
        content.classList.replace('col-md-10', 'col-md-12');
        content.classList.replace('col-lg-11', 'col-lg-12');
    }
}

// გვერდის ჩატვირთვისას მონაცემების წამოღება
loadData();