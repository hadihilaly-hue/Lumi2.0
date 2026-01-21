// Global data storage
let notes = [];
let sources = [];
let charts = {};

// NewsAPI Configuration
const NEWS_API_KEY = '4ccfb9012ee34dca90045e4065140533';
const NEWS_API_URL = 'https://newsapi.org/v2/everything';

// Load saved data from localStorage on page load
window.addEventListener('DOMContentLoaded', () => {
    loadData();
    initializeTabs();
    updateStatistics();
    initializeCharts();
});

// Tab Navigation
function initializeTabs() {
    const tabBtns = document.querySelectorAll('.tab-btn');
    const tabPanes = document.querySelectorAll('.tab-pane');

    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const targetTab = btn.getAttribute('data-tab');

            // Remove active class from all tabs and panes
            tabBtns.forEach(b => b.classList.remove('active'));
            tabPanes.forEach(pane => pane.classList.remove('active'));

            // Add active class to clicked tab and corresponding pane
            btn.classList.add('active');
            document.getElementById(targetTab).classList.add('active');
        });
    });
}

// ===== NEWS & SEARCH FUNCTIONALITY =====

function searchNews() {
    const query = document.getElementById('newsSearch').value;
    if (!query.trim()) {
        alert('Please enter a search term');
        return;
    }
    performSearch(query);
}

function quickSearch(term) {
    document.getElementById('newsSearch').value = term;
    performSearch(term);
}

function performSearch(query) {
    const resultsContainer = document.getElementById('newsResults');
    resultsContainer.innerHTML = `
        <div class="empty-state loading">
            <span class="empty-icon">🔍</span>
            <h3>Searching...</h3>
            <p>Finding the best research on "${query}"</p>
        </div>
    `;

    // Call the real NewsAPI
    const searchQuery = encodeURIComponent(query);
    const apiUrl = `${NEWS_API_URL}?q=${searchQuery}&language=en&sortBy=relevancy&pageSize=20&apiKey=${NEWS_API_KEY}`;

    fetch(apiUrl)
        .then(response => {
            if (!response.ok) {
                throw new Error('API request failed');
            }
            return response.json();
        })
        .then(data => {
            if (data.status === 'ok' && data.articles) {
                displayNewsResults(data.articles);
            } else {
                throw new Error('No articles found');
            }
        })
        .catch(error => {
            console.error('Error fetching news:', error);
            resultsContainer.innerHTML = `
                <div class="empty-state">
                    <span class="empty-icon">😕</span>
                    <h3>Something went wrong</h3>
                    <p>We couldn't fetch articles right now. Please try again later or check your internet connection.</p>
                </div>
            `;
        });
}

function generateMockNews(query) {
    const topics = {
        'politics': [
            { title: 'Legislative Session Opens with Key Policy Debates', source: 'Political Daily', date: '2026-01-17', snippet: 'The new legislative session has begun with heated debates over healthcare reform and climate policy. Lawmakers on both sides present competing visions for the country\'s future.' },
            { title: 'Analysis: Shifting Political Coalitions in Modern Democracy', source: 'Journal of Political Science', date: '2026-01-16', snippet: 'Research shows significant changes in voter alignment and party coalitions over the past decade, with implications for future electoral strategies.' }
        ],
        'international relations': [
            { title: 'Diplomatic Summit Addresses Global Trade Tensions', source: 'Global Affairs Review', date: '2026-01-18', snippet: 'World leaders convene to discuss trade policy, with focus on multilateral cooperation and addressing economic disparities between nations.' },
            { title: 'UN Report: International Cooperation on Climate Action', source: 'International Policy Quarterly', date: '2026-01-15', snippet: 'New report highlights both progress and challenges in global climate cooperation, emphasizing the need for continued diplomatic efforts.' }
        ],
        'policy': [
            { title: 'New Healthcare Policy Framework Proposed', source: 'Policy Review Magazine', date: '2026-01-17', snippet: 'Comprehensive analysis of the proposed healthcare reforms, including cost projections and coverage implications for different demographic groups.' },
            { title: 'Economic Policy Trends in Post-Pandemic Era', source: 'Economic Policy Journal', date: '2026-01-14', snippet: 'Examination of fiscal and monetary policy approaches adopted by governments worldwide in response to economic challenges.' }
        ],
        'elections': [
            { title: 'Electoral Reform Proposals Gain Momentum', source: 'Democracy Watch', date: '2026-01-16', snippet: 'Growing bipartisan support for electoral system reforms, including ranked-choice voting and campaign finance changes.' },
            { title: 'Voter Turnout Patterns in Recent Elections', source: 'Electoral Studies Review', date: '2026-01-12', snippet: 'Comprehensive data analysis reveals demographic trends in voter participation and engagement across different regions.' }
        ],
        'legislation': [
            { title: 'Major Bills Advance Through Committee Process', source: 'Legislative Observer', date: '2026-01-18', snippet: 'Several key pieces of legislation move forward, covering topics from infrastructure to education funding.' },
            { title: 'Understanding the Legislative Process: A Guide', source: 'Civic Education Foundation', date: '2026-01-10', snippet: 'Educational resource explaining how bills become laws, committee structures, and the role of different branches.' }
        ]
    };

    // Find matching topic or use default results
    const lowerQuery = query.toLowerCase();
    let results = [];

    for (const [topic, articles] of Object.entries(topics)) {
        if (lowerQuery.includes(topic)) {
            results = articles;
            break;
        }
    }

    // If no specific match, provide general political science results
    if (results.length === 0) {
        results = [
            { title: 'Research Findings on ' + query, source: 'Political Science Quarterly', date: '2026-01-17', snippet: 'Recent research explores various aspects of ' + query + ', providing insights for scholars and practitioners in the field.' },
            { title: 'Contemporary Perspectives on ' + query, source: 'Academic Policy Review', date: '2026-01-15', snippet: 'Analysis of current trends and developments related to ' + query + ', with implications for policy and governance.' },
            { title: 'Case Study: ' + query + ' in Comparative Context', source: 'Comparative Politics Journal', date: '2026-01-13', snippet: 'Comparative analysis examining ' + query + ' across different political systems and contexts.' }
        ];
    }

    return results;
}

function displayNewsResults(results) {
    const resultsContainer = document.getElementById('newsResults');

    if (!results || results.length === 0) {
        resultsContainer.innerHTML = `
            <div class="empty-state">
                <span class="empty-icon">😕</span>
                <h3>No Results Found</h3>
                <p>We couldn't find any articles matching your search. Try different keywords or explore our quick topics!</p>
            </div>
        `;
        return;
    }

    let html = '';
    results.forEach((article, index) => {
        // Format the date
        const articleDate = article.publishedAt ? new Date(article.publishedAt).toLocaleDateString() : 'N/A';

        // Get description or content preview
        const description = article.description || article.content || 'No description available.';
        const snippet = description.length > 200 ? description.substring(0, 200) + '...' : description;

        // Get source name
        const sourceName = article.source?.name || 'Unknown Source';

        html += `
            <div class="news-item">
                <h3>${article.title}</h3>
                <p>${snippet}</p>
                <div class="news-meta">
                    <span>📰 ${sourceName}</span>
                    <span>📅 ${articleDate}</span>
                </div>
                <div style="display: flex; gap: 10px; margin-top: 15px; flex-wrap: wrap;">
                    <button onclick="window.open('${article.url}', '_blank')" class="read-btn">
                        <span>📖 Read Full Article</span>
                    </button>
                    <button onclick="saveArticleAsNote(${index})" class="save-note-btn">
                        <span>💾 Save to Notes</span>
                    </button>
                </div>
            </div>
        `;
    });

    resultsContainer.innerHTML = html;

    // Store articles globally so we can access them when saving notes
    window.currentArticles = results;
}

function escapeHtml(text) {
    return text.replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

function saveArticleAsNote(index) {
    if (!window.currentArticles || !window.currentArticles[index]) {
        alert('Article not found!');
        return;
    }

    const article = window.currentArticles[index];
    const title = article.title;
    const content = `${article.description || article.content || ''}\n\nSource: ${article.source?.name || 'Unknown'}\nPublished: ${new Date(article.publishedAt).toLocaleDateString()}\nURL: ${article.url}`;

    createNote(title, content);

    // Show notification
    showNotification('✅ Article saved to notes!');

    // Switch to notes tab after a short delay
    setTimeout(() => {
        document.querySelector('[data-tab="notes"]').click();
    }, 500);
}

// ===== NOTES & ANNOTATIONS FUNCTIONALITY =====

function createNote(title = '', content = '') {
    const container = document.getElementById('notesContainer');
    const noteId = 'note_' + Date.now();
    const currentDate = new Date().toISOString().split('T')[0];

    const noteCard = document.createElement('div');
    noteCard.className = 'note-card';
    noteCard.dataset.noteId = noteId;
    noteCard.innerHTML = `
        <div class="note-header">
            <input type="text" class="note-title" placeholder="Note title..." value="${title}">
            <button class="delete-btn" onclick="deleteNote(this)">×</button>
        </div>
        <textarea class="note-content" placeholder="Write your research notes, annotations, and insights here...">${content}</textarea>
        <div class="note-meta">
            <input type="text" class="note-tags" placeholder="Add tags (comma-separated)...">
            <span class="note-date">Created: <span class="date-value">${currentDate}</span></span>
        </div>
    `;

    container.insertBefore(noteCard, container.firstChild);

    // Save note data
    const note = {
        id: noteId,
        title: title,
        content: content,
        tags: '',
        date: currentDate
    };
    notes.push(note);
    saveData();
    updateStatistics();

    // Add event listeners for auto-save
    noteCard.querySelector('.note-title').addEventListener('input', saveNotes);
    noteCard.querySelector('.note-content').addEventListener('input', saveNotes);
    noteCard.querySelector('.note-tags').addEventListener('input', saveNotes);
}

function deleteNote(btn) {
    if (confirm('Are you sure you want to delete this note?')) {
        const noteCard = btn.closest('.note-card');
        const noteId = noteCard.dataset.noteId;

        // Remove from data
        notes = notes.filter(note => note.id !== noteId);

        // Remove from DOM
        noteCard.remove();

        saveData();
        updateStatistics();
    }
}

function saveNotes() {
    const noteCards = document.querySelectorAll('.note-card');
    notes = [];

    noteCards.forEach(card => {
        const note = {
            id: card.dataset.noteId,
            title: card.querySelector('.note-title').value,
            content: card.querySelector('.note-content').value,
            tags: card.querySelector('.note-tags').value,
            date: card.querySelector('.date-value').textContent
        };
        notes.push(note);
    });

    saveData();
    updateStatistics();
}

// Note filtering
document.addEventListener('DOMContentLoaded', () => {
    const noteFilter = document.getElementById('noteFilter');
    if (noteFilter) {
        noteFilter.addEventListener('input', (e) => {
            const filterText = e.target.value.toLowerCase();
            const noteCards = document.querySelectorAll('.note-card');

            noteCards.forEach(card => {
                const title = card.querySelector('.note-title').value.toLowerCase();
                const content = card.querySelector('.note-content').value.toLowerCase();
                const tags = card.querySelector('.note-tags').value.toLowerCase();

                if (title.includes(filterText) || content.includes(filterText) || tags.includes(filterText)) {
                    card.style.display = '';
                } else {
                    card.style.display = 'none';
                }
            });
        });
    }
});

// ===== SOURCES & CITATIONS FUNCTIONALITY =====

function addSource(event) {
    event.preventDefault();

    const source = {
        id: 'source_' + Date.now(),
        title: document.getElementById('sourceTitle').value,
        author: document.getElementById('sourceAuthor').value,
        url: document.getElementById('sourceURL').value,
        publisher: document.getElementById('sourcePublisher').value,
        date: document.getElementById('sourceDate').value,
        type: document.getElementById('sourceType').value
    };

    sources.push(source);
    saveData();
    displaySources();
    updateStatistics();

    // Reset form
    document.getElementById('sourceForm').reset();
}

function displaySources() {
    const container = document.getElementById('sourcesContainer');
    const format = document.getElementById('citationFormat').value;

    if (sources.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <span class="empty-icon">📚</span>
                <h3>No Sources Yet</h3>
                <p>Start building your bibliography by adding your first source above!</p>
            </div>
        `;
        return;
    }

    let html = '';
    sources.forEach((source, index) => {
        const citation = generateCitation(source, format);
        html += `
            <div class="source-item" data-source-id="${source.id}">
                <div class="citation">${citation}</div>
                <div class="source-actions">
                    <button class="copy-btn" onclick="copyCitation('${escapeHtml(citation)}')">
                        <span>📋 Copy Citation</span>
                    </button>
                    <button class="remove-btn" onclick="removeSource('${source.id}')">
                        <span>🗑️ Remove</span>
                    </button>
                </div>
            </div>
        `;
    });

    container.innerHTML = html;
}

function generateCitation(source, format) {
    const date = new Date(source.date);
    const year = date.getFullYear();

    switch(format) {
        case 'apa':
            // APA 7th Edition format
            let apa = '';
            if (source.author) {
                apa += source.author + '. ';
            }
            apa += '(' + year + '). ';
            apa += '<i>' + source.title + '</i>. ';
            if (source.publisher) {
                apa += source.publisher + '. ';
            }
            if (source.url) {
                apa += source.url;
            }
            return apa;

        case 'mla':
            // MLA 9th Edition format
            let mla = '';
            if (source.author) {
                mla += source.author + '. ';
            }
            mla += '"' + source.title + '." ';
            if (source.publisher) {
                mla += '<i>' + source.publisher + '</i>, ';
            }
            mla += year + '. ';
            if (source.url) {
                mla += source.url + '.';
            }
            return mla;

        case 'chicago':
            // Chicago format
            let chicago = '';
            if (source.author) {
                chicago += source.author + '. ';
            }
            chicago += '"' + source.title + '." ';
            if (source.publisher) {
                chicago += '<i>' + source.publisher + '</i> ';
            }
            chicago += '(' + year + '). ';
            if (source.url) {
                chicago += source.url + '.';
            }
            return chicago;

        default:
            return source.title + ' by ' + source.author + ' (' + year + ')';
    }
}

function updateCitations() {
    displaySources();
}

function copyCitation(citation) {
    // Remove HTML tags for clipboard
    const text = citation.replace(/<[^>]*>/g, '');
    navigator.clipboard.writeText(text).then(() => {
        showNotification('✅ Citation copied to clipboard!');
    }).catch(() => {
        alert('Citation copied to clipboard!');
    });
}

// Show temporary notification
function showNotification(message) {
    // Remove any existing notification
    const existing = document.querySelector('.notification');
    if (existing) existing.remove();

    // Create notification
    const notification = document.createElement('div');
    notification.className = 'notification';
    notification.textContent = message;
    notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: linear-gradient(135deg, #10b981 0%, #06b6d4 100%);
        color: white;
        padding: 15px 25px;
        border-radius: 15px;
        box-shadow: 0 10px 25px rgba(0, 0, 0, 0.2);
        z-index: 10000;
        font-weight: 600;
        animation: slideIn 0.3s ease;
    `;

    document.body.appendChild(notification);

    // Remove after 3 seconds
    setTimeout(() => {
        notification.style.animation = 'slideOut 0.3s ease';
        setTimeout(() => notification.remove(), 300);
    }, 3000);
}

function removeSource(sourceId) {
    if (confirm('Are you sure you want to remove this source?')) {
        sources = sources.filter(source => source.id !== sourceId);
        saveData();
        displaySources();
        updateStatistics();
    }
}

// ===== ANALYTICS & VISUALIZATION =====

function updateStatistics() {
    // Update stat numbers in analytics tab
    document.getElementById('statNotes').textContent = notes.length;
    document.getElementById('statSources').textContent = sources.length;

    // Update header stats
    const headerNotes = document.getElementById('headerNotes');
    const headerSources = document.getElementById('headerSources');
    if (headerNotes) headerNotes.textContent = notes.length;
    if (headerSources) headerSources.textContent = sources.length;

    // Count unique tags
    const allTags = notes.map(note => note.tags).join(',').split(',');
    const uniqueTags = new Set(allTags.filter(tag => tag.trim() !== ''));
    document.getElementById('statTopics').textContent = uniqueTags.size;

    // Update charts if they exist
    if (Object.keys(charts).length > 0) {
        updateCharts();
    }
}

function initializeCharts() {
    // Topics Distribution Chart
    const topicsCtx = document.getElementById('topicsChart');
    if (topicsCtx) {
        charts.topics = new Chart(topicsCtx, {
            type: 'doughnut',
            data: {
                labels: [],
                datasets: [{
                    data: [],
                    backgroundColor: [
                        '#667eea', '#764ba2', '#f093fb', '#4facfe',
                        '#43e97b', '#fa709a', '#fee140', '#30cfd0'
                    ]
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: true,
                plugins: {
                    legend: {
                        position: 'bottom'
                    }
                }
            }
        });
    }

    // Timeline Chart
    const timelineCtx = document.getElementById('timelineChart');
    if (timelineCtx) {
        charts.timeline = new Chart(timelineCtx, {
            type: 'line',
            data: {
                labels: [],
                datasets: [{
                    label: 'Research Items Added',
                    data: [],
                    borderColor: '#667eea',
                    backgroundColor: 'rgba(102, 126, 234, 0.1)',
                    tension: 0.4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: true,
                plugins: {
                    legend: {
                        display: false
                    }
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        ticks: {
                            stepSize: 1
                        }
                    }
                }
            }
        });
    }

    // Source Types Chart
    const sourceTypesCtx = document.getElementById('sourceTypesChart');
    if (sourceTypesCtx) {
        charts.sourceTypes = new Chart(sourceTypesCtx, {
            type: 'bar',
            data: {
                labels: [],
                datasets: [{
                    label: 'Number of Sources',
                    data: [],
                    backgroundColor: '#667eea'
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: true,
                plugins: {
                    legend: {
                        display: false
                    }
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        ticks: {
                            stepSize: 1
                        }
                    }
                }
            }
        });
    }

    updateCharts();
}

function updateCharts() {
    // Update Topics Chart
    if (charts.topics) {
        const tagCounts = {};
        notes.forEach(note => {
            const tags = note.tags.split(',').map(t => t.trim()).filter(t => t !== '');
            tags.forEach(tag => {
                tagCounts[tag] = (tagCounts[tag] || 0) + 1;
            });
        });

        const sortedTags = Object.entries(tagCounts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 8);

        charts.topics.data.labels = sortedTags.map(t => t[0]) || ['No tags yet'];
        charts.topics.data.datasets[0].data = sortedTags.map(t => t[1]) || [0];
        charts.topics.update();
    }

    // Update Timeline Chart
    if (charts.timeline) {
        const dateCounts = {};
        [...notes, ...sources].forEach(item => {
            const date = item.date;
            dateCounts[date] = (dateCounts[date] || 0) + 1;
        });

        const sortedDates = Object.entries(dateCounts)
            .sort((a, b) => new Date(a[0]) - new Date(b[0]))
            .slice(-7); // Last 7 dates

        charts.timeline.data.labels = sortedDates.map(d => d[0]) || ['No data'];
        charts.timeline.data.datasets[0].data = sortedDates.map(d => d[1]) || [0];
        charts.timeline.update();
    }

    // Update Source Types Chart
    if (charts.sourceTypes) {
        const typeCounts = {};
        sources.forEach(source => {
            typeCounts[source.type] = (typeCounts[source.type] || 0) + 1;
        });

        const typeLabels = {
            'article': 'Journal Articles',
            'news': 'News Articles',
            'book': 'Books',
            'report': 'Reports',
            'website': 'Websites'
        };

        charts.sourceTypes.data.labels = Object.keys(typeCounts).map(t => typeLabels[t] || t);
        charts.sourceTypes.data.datasets[0].data = Object.values(typeCounts);
        charts.sourceTypes.update();
    }
}

// ===== DATA PERSISTENCE =====

function saveData() {
    localStorage.setItem('researchNotes', JSON.stringify(notes));
    localStorage.setItem('researchSources', JSON.stringify(sources));
}

function loadData() {
    // Load notes
    const savedNotes = localStorage.getItem('researchNotes');
    if (savedNotes) {
        notes = JSON.parse(savedNotes);
        const container = document.getElementById('notesContainer');

        notes.forEach(note => {
            const noteCard = document.createElement('div');
            noteCard.className = 'note-card';
            noteCard.dataset.noteId = note.id;
            noteCard.innerHTML = `
                <div class="note-header">
                    <input type="text" class="note-title" placeholder="Note title..." value="${note.title}">
                    <button class="delete-btn" onclick="deleteNote(this)">×</button>
                </div>
                <textarea class="note-content" placeholder="Write your research notes, annotations, and insights here...">${note.content}</textarea>
                <div class="note-meta">
                    <input type="text" class="note-tags" placeholder="Add tags (comma-separated)..." value="${note.tags}">
                    <span class="note-date">Created: <span class="date-value">${note.date}</span></span>
                </div>
            `;

            container.appendChild(noteCard);

            // Add event listeners
            noteCard.querySelector('.note-title').addEventListener('input', saveNotes);
            noteCard.querySelector('.note-content').addEventListener('input', saveNotes);
            noteCard.querySelector('.note-tags').addEventListener('input', saveNotes);
        });
    }

    // Load sources
    const savedSources = localStorage.getItem('researchSources');
    if (savedSources) {
        sources = JSON.parse(savedSources);
        displaySources();
    }
}
