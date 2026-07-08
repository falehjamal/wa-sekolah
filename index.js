import 'dotenv/config';
import express from 'express';
import { sessionRouter, messageRouter } from './routes/session.js';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// API Key middleware
app.use((req, res, next) => {
    // Health check tanpa auth
    if (req.path === '/health') return next();

    const apiKey = req.headers['x-api-key'];
    if (!process.env.API_KEY || apiKey !== process.env.API_KEY) {
        return res.status(401).json({ success: false, message: 'Unauthorized: Invalid API Key' });
    }
    next();
});

// Routes
app.use('/sessions', sessionRouter);
app.use('/messages', messageRouter);

// Health check
app.get('/health', (_req, res) => {
    res.json({ success: true, message: 'WA Gateway is running' });
});

app.listen(PORT, '127.0.0.1', () => {
    console.log(`[WA Gateway] Server berjalan di http://127.0.0.1:${PORT}`);
});
