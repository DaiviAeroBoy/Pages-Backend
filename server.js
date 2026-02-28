/**
 * PageVault Backend Server
 * ========================
 * Handles book uploads and automatically commits them to GitHub.
 * Users upload to this server → server pushes to GitHub → GitHub Pages serves the library.
 *
 * Stack: Node.js · Express · Multer · GitHub Contents API · CORS
 */

require('dotenv').config();
const express = require('express');
const multer  = require('multer');
const cors    = require('cors');
const path    = require('path');
const fetch   = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const app  = express();
const PORT = process.env.PORT || 3001;

// ─── Environment Variables ─────────────────────────────────────────────────────
const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;   // Your GitHub Personal Access Token
const GITHUB_OWNER  = process.env.GITHUB_OWNER;   // Your GitHub username
const GITHUB_REPO   = process.env.GITHUB_REPO;    // Must be: Pages  (your frontend repo)
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const ADMIN_SECRET  = process.env.ADMIN_SECRET  || 'changeme-admin-secret';

if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
  console.error('Missing required env vars: GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO');
  console.error('Copy env.example.txt to .env and fill in your values.');
  process.exit(1);
}

// ─── CORS ──────────────────────────────────────────────────────────────────────
app.use(cors({
  origin: [
    `https://${GITHUB_OWNER}.github.io`,
    'http://localhost:3000',
    'http://127.0.0.1:5500',
    ...(process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : [])
  ],
  methods: ['GET', 'POST', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '10mb' }));

// ─── File Upload ───────────────────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.pdf', '.epub'].includes(ext)) cb(null, true);
    else cb(new Error('Only PDF and EPUB files are accepted.'));
  }
});

// ─── GitHub API Helpers ────────────────────────────────────────────────────────
const GH_API    = 'https://api.github.com';
const ghHeaders = {
  Authorization: `Bearer ${GITHUB_TOKEN}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'Content-Type': 'application/json',
  'User-Agent': 'PageVault-Server/1.0'
};

async function getFileSHA(filePath) {
  const url = `${GH_API}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${filePath}?ref=${GITHUB_BRANCH}`;
  const res = await fetch(url, { headers: ghHeaders });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub SHA error: ${res.status} ${await res.text()}`);
  return (await res.json()).sha;
}

async function commitFileToGitHub(filePath, content, message, sha = null) {
  const url  = `${GH_API}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${filePath}`;
  const body = { message, content, branch: GITHUB_BRANCH, ...(sha ? { sha } : {}) };
  const res  = await fetch(url, { method: 'PUT', headers: ghHeaders, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`GitHub commit failed (${res.status}): ${await res.text()}`);
  return res.json();
}

async function getBooksJson() {
  const url = `${GH_API}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/books.json?ref=${GITHUB_BRANCH}`;
  const res = await fetch(url, { headers: ghHeaders });
  if (res.status === 404) return { books: [], sha: null };
  if (!res.ok) throw new Error(`Failed to fetch books.json: ${res.status}`);
  const data  = await res.json();
  const books = JSON.parse(Buffer.from(data.content, 'base64').toString('utf-8'));
  return { books: Array.isArray(books) ? books : [], sha: data.sha };
}

async function saveBooksJson(books, sha) {
  const content = Buffer.from(JSON.stringify(books, null, 2)).toString('base64');
  return commitFileToGitHub('books.json', content, `Update catalog — ${books.length} books`, sha);
}

function slugify(str) {
  return str.toLowerCase()
    .replace(/[àáâãäå]/g,'a').replace(/[èéêë]/g,'e')
    .replace(/[ìíîï]/g,'i').replace(/[òóôõö]/g,'o')
    .replace(/[ùúûü]/g,'u').replace(/[ñ]/g,'n')
    .replace(/[^a-z0-9\s-]/g,'').trim()
    .replace(/\s+/g,'-').replace(/-+/g,'-').slice(0, 60);
}

const genreColors = {
  'Fiction':'#9c3d2e','Non-Fiction':'#556b55','Science':'#3a4a5a',
  'History':'#7a5a2a','Philosophy':'#4a5a7a','Biography':'#5a4570',
  'Poetry':'#7a4a2a','Children':'#3a6b60','Technology':'#2a5a6a',
  'Religion & Spirituality':'#6a5535','Politics & Society':'#5a3a5a',
  'Art & Culture':'#6a3a4a','Other':'#4a4a4a'
};

// ─── Routes ────────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({ status: 'ok', repo: `${GITHUB_OWNER}/${GITHUB_REPO}`, timestamp: new Date().toISOString() });
});

app.get('/api/books', async (req, res) => {
  try {
    const { books } = await getBooksJson();
    res.json({ success: true, count: books.length, books });
  } catch (err) {
    console.error('GET /api/books:', err.message);
    res.status(500).json({ success: false, error: 'Failed to fetch books catalog.' });
  }
});

app.post('/api/upload', upload.single('bookFile'), async (req, res) => {
  try {
    const { title, author, genre, year, language, description } = req.body;

    if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded.' });
    if (!title)   return res.status(400).json({ success: false, error: 'Title is required.' });
    if (!author)  return res.status(400).json({ success: false, error: 'Author is required.' });
    if (!genre)   return res.status(400).json({ success: false, error: 'Genre is required.' });

    const ext      = path.extname(req.file.originalname).toLowerCase();
    const format   = ext === '.epub' ? 'EPUB' : 'PDF';
    const filename = `${slugify(title)}-${slugify(author)}${ext}`;
    const filePath = `books/${filename}`;
    const fileSize = (req.file.size / (1024 * 1024)).toFixed(1) + ' MB';

    console.log(`Uploading: ${filePath} (${fileSize})`);

    const existingSHA = await getFileSHA(filePath);
    await commitFileToGitHub(filePath, req.file.buffer.toString('base64'), `Add: ${title} by ${author}`, existingSHA);

    const { books, sha: booksSHA } = await getBooksJson();
    const nextId = books.length > 0 ? Math.max(...books.map(b => b.id || 0)) + 1 : 1;

    const newBook = {
      id:          nextId,
      title:       title.trim(),
      author:      author.trim(),
      genre:       genre.trim(),
      year:        year ? parseInt(year) : null,
      language:    (language || 'English').trim(),
      size:        fileSize,
      format,
      description: (description || '').trim(),
      file:        filePath,
      color:       genreColors[genre] || '#4a4a4a',
      uploadedAt:  new Date().toISOString()
    };

    books.push(newBook);
    await saveBooksJson(books, booksSHA);

    console.log(`"${title}" added. Total: ${books.length}`);
    res.json({ success: true, message: `"${title}" has been added to the library!`, book: newBook, total: books.length });

  } catch (err) {
    console.error('POST /api/upload:', err.message);
    res.status(500).json({ success: false, error: err.message || 'Upload failed. Please try again.' });
  }
});

app.delete('/api/books/:id', async (req, res) => {
  if (req.headers.authorization !== `Bearer ${ADMIN_SECRET}`) {
    return res.status(401).json({ success: false, error: 'Unauthorized.' });
  }
  try {
    const id = parseInt(req.params.id);
    const { books, sha } = await getBooksJson();
    const idx = books.findIndex(b => b.id === id);
    if (idx === -1) return res.status(404).json({ success: false, error: 'Book not found.' });
    const [removed] = books.splice(idx, 1);
    await saveBooksJson(books, sha);
    res.json({ success: true, message: `"${removed.title}" removed.`, removed });
  } catch (err) {
    console.error('DELETE /api/books:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ success: false, error: 'File too large. Max 50 MB.' });
  if (err.message?.includes('Only PDF')) return res.status(400).json({ success: false, error: err.message });
  console.error('Unhandled error:', err);
  res.status(500).json({ success: false, error: 'Internal server error.' });
});

app.listen(PORT, () => {
  console.log(`PageVault Backend running on port ${PORT}`);
  console.log(`Repo: https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}`);
  console.log(`Health: http://localhost:${PORT}/health`);
});
