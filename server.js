require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { initDb } = require('./utils/db');
const { initRedis } = require('./utils/redisClient');
const { scheduleCronJobs } = require('./cron/scheduler');
const { authenticate } = require('./middleware/auth');

const app = express();

// Security middleware
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "https://www.google.com/recaptcha/", "https://www.gstatic.com/"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", "data:", "https:"],
            connectSrc: ["'self'", process.env.ALLOWED_ORIGIN || "*"],
            frameSrc: ["'self'", "https://www.google.com/"],
        },
    },
}));

// CORS configuration
const allowedOrigins = (process.env.FRONTEND_URLS || '').split(',').filter(Boolean);
app.use(cors({
    origin: function (origin, callback) {
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Recaptcha-Token', 'X-Device-Id'],
}));

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());

// Rate limiting
const limiter = rateLimit({
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 900000,
    max: parseInt(process.env.RATE_LIMIT_MAX) || 100,
    message: { error: 'Too many requests, please try again later' },
    keyGenerator: (req) => req.headers['cf-connecting-ip'] || req.ip,
});
app.use('/api/', limiter);

// Auth rate limiting (stricter)
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    skipSuccessfulRequests: true,
    message: { error: 'Too many login attempts, please try again after 15 minutes' },
});
app.use('/api/auth/', authLimiter);

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/ad', require('./routes/ad'));
app.use('/api/admin', authenticate(['admin']), require('./routes/admin'));
app.use('/api/advertiser', authenticate(['advertiser']), require('./routes/advertiser'));
app.use('/api/publisher', authenticate(['publisher']), require('./routes/publisher'));
app.use('/api/payment', authenticate(), require('./routes/payment'));

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

// Start server
const PORT = process.env.PORT || 3000;

async function startServer() {
    try {
        await initDb();
        console.log('✅ Database connected');
        
        await initRedis();
        console.log('✅ Redis connected');
        
        scheduleCronJobs();
        console.log('✅ Cron jobs scheduled');
        
        app.listen(PORT, () => {
            console.log(`🚀 Server running on port ${PORT}`);
            console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
        });
    } catch (err) {
        console.error('❌ Failed to start server:', err);
        process.exit(1);
    }
}

startServer();
