const express = require('express');
const fs = require('fs');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');

loadEnvFile(path.join(__dirname, '.env'));

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_TEXT_MODEL = process.env.GEMINI_TEXT_MODEL || 'gemini-2.5-flash';
const GEMINI_VISION_MODEL = process.env.GEMINI_VISION_MODEL || GEMINI_TEXT_MODEL;
const GEMINI_TIMEOUT_MS = Number.parseInt(process.env.GEMINI_TIMEOUT_MS, 10) || 60000;

const MAX_UPLOAD_SIZE_BYTES = 8 * 1024 * 1024;
const MAX_REQUIREMENTS_LENGTH = 4000;
const MAX_CHAT_LENGTH = 700;
const MAX_NAME_LENGTH = 40;
const MAX_EXTRACTED_TEXT_LENGTH = 120000;
const MAX_TEXT_LENGTH_FOR_MODEL = 60000;
const MIN_EXTRACTED_TEXT_LENGTH = 80;
const CHAT_HISTORY_LIMIT = 120;

const EXTENSION_TO_MIME = {
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

const SUPPORTED_MIME_TYPES = new Set([
  'application/pdf',
  'text/plain',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/png',
  'image/jpeg',
  'image/webp',
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_UPLOAD_SIZE_BYTES,
  },
});

const clients = new Set();
const chatHistory = [];
let nextSocketId = 1;

app.use(express.static(path.join(__dirname, 'public')));

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const envText = fs.readFileSync(filePath, 'utf8');
  for (const line of envText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const match = trimmed.match(/^([\w.-]+)\s*=\s*(.*)$/);
    if (!match) {
      continue;
    }

    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) {
      continue;
    }

    let value = rawValue.trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

function normalizeText(input, maxLength) {
  return String(input ?? '').replace(/\r\n/g, '\n').trim().slice(0, maxLength);
}

function normalizeWhitespace(input) {
  return String(input ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function getFileExtension(fileName) {
  return path.extname(String(fileName || '')).toLowerCase();
}

function normalizeMimeType(mimeType, fileName) {
  const rawMime = String(mimeType || '').toLowerCase().trim();
  if (rawMime && rawMime !== 'application/octet-stream') {
    return rawMime;
  }

  const byExtension = EXTENSION_TO_MIME[getFileExtension(fileName)];
  return byExtension || rawMime;
}

function sanitizeName(input, fallback) {
  const cleaned = normalizeText(input, MAX_NAME_LENGTH)
    .replace(/\s+/g, ' ')
    .replace(/[<>]/g, '');
  return cleaned || fallback;
}

function sendToClient(ws, data) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return;
  }

  ws.send(JSON.stringify(data));
}

function broadcast(data) {
  clients.forEach((client) => {
    sendToClient(client, data);
  });
}

function createMessageId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function getOnlineUsers() {
  return Array.from(clients).map((client) => ({
    id: client.clientId,
    name: client.displayName,
  }));
}

function trimChatHistory() {
  if (chatHistory.length > CHAT_HISTORY_LIMIT) {
    chatHistory.splice(0, chatHistory.length - CHAT_HISTORY_LIMIT);
  }
}

function addChatEntry(entry) {
  chatHistory.push(entry);
  trimChatHistory();
  broadcast({ type: 'chat', entry });
}

function addSystemChat(text) {
  addChatEntry({
    id: createMessageId('chat'),
    kind: 'system',
    text,
    createdAt: Date.now(),
  });
}

function broadcastPresence(statusMessage = '') {
  broadcast({
    type: 'presence',
    users: getOnlineUsers(),
    onlineCount: clients.size,
    statusMessage,
  });
}

function extractResponseText(payload) {
  const candidates = payload?.candidates || [];
  const textParts = [];

  for (const candidate of candidates) {
    for (const part of candidate?.content?.parts || []) {
      if (typeof part?.text === 'string' && part.text.trim()) {
        textParts.push(part.text.trim());
      }
    }
  }

  return textParts.join('\n').trim();
}

function formatGeminiError(error) {
  if (error.name === 'TimeoutError') {
    return 'Gemini tra loi qua lau. Thu rut gon prompt hoac thu lai.';
  }

  const message = String(error.message || '').trim();
  if (/GEMINI_API_KEY/i.test(message)) {
    return message;
  }

  if (error.statusCode === 429 || /quota/i.test(message) || /rate limit/i.test(message)) {
    return 'Gemini da het quota cho API key nay.';
  }

  if (error.statusCode >= 500) {
    return 'Gemini dang loi tam thoi. Thu lai sau it phut.';
  }

  return message || 'Khong the goi Gemini.';
}

async function requestGeminiGenerateContent(options) {
  if (!GEMINI_API_KEY) {
    const missingKeyError = new Error('Chua cau hinh GEMINI_API_KEY trong .env.');
    missingKeyError.statusCode = 500;
    throw missingKeyError;
  }

  const model = options.model || GEMINI_TEXT_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

  const requestBody = {
    contents: options.contents,
  };

  if (options.systemInstruction) {
    requestBody.system_instruction = {
      parts: [{ text: options.systemInstruction }],
    };
  }

  if (options.generationConfig) {
    requestBody.generationConfig = options.generationConfig;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': GEMINI_API_KEY,
    },
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(payload?.error?.message || `Gemini request failed with status ${response.status}.`);
    error.statusCode = response.status;
    throw error;
  }

  return payload;
}

async function extractTextWithGeminiFile(fileBuffer, mimeType) {
  const ocrPrompt = [
    'Extract all readable text from this CV file.',
    'Return plain text only.',
    'Keep line breaks and section order.',
    'Do not summarize and do not evaluate.',
  ].join('\n');

  const payload = await requestGeminiGenerateContent({
    model: GEMINI_VISION_MODEL,
    contents: [
      {
        role: 'user',
        parts: [
          { text: ocrPrompt },
          {
            inline_data: {
              mime_type: mimeType,
              data: fileBuffer.toString('base64'),
            },
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0,
    },
  });

  const text = normalizeWhitespace(extractResponseText(payload));
  if (!text) {
    const emptyError = new Error('Khong trich xuat duoc text tu CV.');
    emptyError.statusCode = 422;
    throw emptyError;
  }

  return text;
}

async function extractTextFromCv(file) {
  const mimeType = normalizeMimeType(file.mimetype, file.originalname);
  const fileBuffer = file.buffer;

  if (mimeType === 'text/plain') {
    return normalizeWhitespace(fileBuffer.toString('utf8'));
  }

  if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    const result = await mammoth.extractRawText({ buffer: fileBuffer });
    return normalizeWhitespace(result.value);
  }

  if (mimeType === 'application/pdf') {
    try {
      const parsed = await pdfParse(fileBuffer);
      const fromPdf = normalizeWhitespace(parsed.text || '');
      if (fromPdf.length >= MIN_EXTRACTED_TEXT_LENGTH) {
        return fromPdf;
      }
    } catch {}

    return extractTextWithGeminiFile(fileBuffer, mimeType);
  }

  if (mimeType.startsWith('image/')) {
    return extractTextWithGeminiFile(fileBuffer, mimeType);
  }

  const unsupportedError = new Error('File khong duoc ho tro. Dung PDF, DOCX, TXT, PNG, JPG, WEBP.');
  unsupportedError.statusCode = 400;
  throw unsupportedError;
}

function buildEvaluationPrompt(requirements, cvText) {
  const requirementSection = requirements || 'Danh gia tong quat cho vi tri phu hop.';

  return [
    'Hay danh gia CV duoi day theo dung yeu cau cua nguoi dung.',
    'Tra loi bang tieng Viet ro rang va de scan.',
    'Mac dinh chia thanh cac muc: Tong quan, Diem manh, Diem yeu, Goi y cai thien, Diem de xuat tren thang 100.',
    'Neu yeu cau nguoi dung co format rieng thi uu tien theo yeu cau nguoi dung.',
    '',
    '=== Yeu cau danh gia ===',
    requirementSection,
    '',
    '=== Noi dung CV ===',
    cvText,
  ].join('\n');
}

async function evaluateCvText(cvText, requirements) {
  const trimmedCvText = normalizeWhitespace(cvText).slice(0, MAX_TEXT_LENGTH_FOR_MODEL);
  const prompt = buildEvaluationPrompt(requirements, trimmedCvText);

  const payload = await requestGeminiGenerateContent({
    model: GEMINI_TEXT_MODEL,
    contents: [
      {
        role: 'user',
        parts: [{ text: prompt }],
      },
    ],
    generationConfig: {
      temperature: 0.3,
    },
  });

  const evaluation = normalizeWhitespace(extractResponseText(payload));
  if (!evaluation) {
    const emptyEvaluationError = new Error('Gemini khong tra ve noi dung danh gia.');
    emptyEvaluationError.statusCode = 422;
    throw emptyEvaluationError;
  }

  return {
    evaluation,
    charsSentToModel: trimmedCvText.length,
    trimmedForModel: cvText.length > trimmedCvText.length,
  };
}

app.post('/api/cv/evaluate', upload.single('cvFile'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Ban chua tai file CV.' });
    }

    const normalizedMime = normalizeMimeType(req.file.mimetype, req.file.originalname);
    if (!SUPPORTED_MIME_TYPES.has(normalizedMime)) {
      return res.status(400).json({
        error: 'File khong ho tro. Dung PDF, DOCX, TXT, PNG, JPG, WEBP.',
      });
    }

    const requirements = normalizeText(req.body?.requirements, MAX_REQUIREMENTS_LENGTH);
    const extractedText = (await extractTextFromCv({
      ...req.file,
      mimetype: normalizedMime,
    })).slice(0, MAX_EXTRACTED_TEXT_LENGTH);

    if (!extractedText || extractedText.length < 20) {
      return res.status(422).json({
        error: 'Khong doc du text tu CV. Thu file ro net hon hoac dinh dang khac.',
      });
    }

    const evaluationResult = await evaluateCvText(extractedText, requirements);

    return res.json({
      ok: true,
      fileName: req.file.originalname,
      mimeType: normalizedMime,
      extractedText,
      extractedChars: extractedText.length,
      charsSentToModel: evaluationResult.charsSentToModel,
      trimmedForModel: evaluationResult.trimmedForModel,
      evaluation: evaluationResult.evaluation,
    });
  } catch (error) {
    const status = Number.parseInt(error.statusCode, 10);
    const safeStatus = status >= 400 && status < 600 ? status : 500;
    const safeMessage = safeStatus >= 500 ? formatGeminiError(error) : (error.message || 'Khong the xu ly CV.');

    console.error('CV evaluate failed:', error.message);
    return res.status(safeStatus).json({
      error: safeMessage,
    });
  }
});

app.use((error, req, res, next) => {
  if (!(error instanceof multer.MulterError)) {
    return next(error);
  }

  if (error.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({
      error: `File qua lon. Gioi han ${Math.round(MAX_UPLOAD_SIZE_BYTES / (1024 * 1024))}MB.`,
    });
  }

  return res.status(400).json({
    error: 'Upload file that bai. Thu lai.',
  });
});

wss.on('connection', (ws) => {
  ws.socketId = nextSocketId++;
  ws.clientId = `user-${ws.socketId}`;
  ws.displayName = `User ${ws.socketId}`;

  clients.add(ws);

  sendToClient(ws, {
    type: 'init',
    self: {
      id: ws.clientId,
      name: ws.displayName,
    },
    users: getOnlineUsers(),
    onlineCount: clients.size,
    chatHistory,
  });

  addSystemChat(`${ws.displayName} da vao chat.`);
  broadcastPresence(`${ws.displayName} vua ket noi.`);

  ws.on('message', (rawMessage) => {
    let data;
    try {
      data = JSON.parse(rawMessage);
    } catch {
      return;
    }
    // WebRTC signaling relay
    if (data.type === 'signal' && data.to && data.data) {
      for (const client of clients) {
        if (client.clientId === data.to && client.readyState === WebSocket.OPEN) {
          sendToClient(client, {
            type: 'signal',
            from: ws.clientId,
            data: data.data,
          });
        }
      }
      return;
    }

    // Chess move relay (broadcast cho tất cả client trừ người gửi)
    if (data.type === 'chess_move' && data.move) {
      for (const client of clients) {
        if (client !== ws && client.readyState === WebSocket.OPEN) {
          sendToClient(client, {
            type: 'chess_move',
            move: data.move,
          });
        }
      }
      return;
    }

    if (data.type === 'set_name') {
      const nextName = sanitizeName(data.name, ws.displayName);
      if (nextName !== ws.displayName) {
        const previousName = ws.displayName;
        ws.displayName = nextName;
        addSystemChat(`${previousName} doi ten thanh ${nextName}.`);
        broadcastPresence('Co nguoi vua doi ten.');
      }
      return;
    }

    if (data.type === 'chat') {
      const text = normalizeText(data.text, MAX_CHAT_LENGTH);
      if (!text) {
        return;
      }

      addChatEntry({
        id: createMessageId('chat'),
        kind: 'user',
        senderId: ws.clientId,
        senderName: ws.displayName,
        text,
        createdAt: Date.now(),
      });
      return;
    }
  });

  ws.on('close', () => {
    if (!clients.has(ws)) {
      return;
    }

    clients.delete(ws);
    addSystemChat(`${ws.displayName} da roi chat.`);
    broadcastPresence(`${ws.displayName} vua ngat ket noi.`);
  });
});

const DEFAULT_PORT = Number.parseInt(process.env.PORT, 10) || 5000;
const MAX_PORT_SCAN_ATTEMPTS = 30;
let currentPort = DEFAULT_PORT;
let listenAttempts = 0;

function listenOnPort(port) {
  currentPort = port;
  server.listen(currentPort, '0.0.0.0');
}

server.on('error', (error) => {
  if ((error.code === 'EADDRINUSE' || error.code === 'EACCES') && listenAttempts < MAX_PORT_SCAN_ATTEMPTS) {
    listenAttempts += 1;
    const nextPort = currentPort + 1;
    console.warn(`Port ${currentPort} unavailable (${error.code}). Retrying on port ${nextPort}...`);
    setTimeout(() => listenOnPort(nextPort), 100);
    return;
  }

  console.error('Failed to start server:', error);
  process.exit(1);
});

wss.on('error', (error) => {
  console.error('WebSocket server error:', error.message);
});

server.on('listening', () => {
  const address = server.address();
  const activePort = typeof address === 'object' && address ? address.port : currentPort;
  console.log(`CV Reviewer WebSocket server running at http://localhost:${activePort}`);
  if (!GEMINI_API_KEY) {
    console.warn('Gemini disabled: GEMINI_API_KEY is not set.');
  }
});

listenOnPort(DEFAULT_PORT);
