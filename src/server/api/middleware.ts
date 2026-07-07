import { Request, Response, NextFunction } from 'express';

interface RateLimitState {
    tokens: number;
    lastUpdate: number;
}

const RATE_LIMIT_WINDOW_MS = 60000;
const MAX_TOKENS = 60; // 60 requests per minute
const TOKEN_RECOVERY_RATE = MAX_TOKENS / RATE_LIMIT_WINDOW_MS;

const rateLimitStore = new Map<string, RateLimitState>();

/**
 * Simple token-bucket rate limiter middleware.
 */
export function rateLimitMiddleware(req: Request, res: Response, next: NextFunction) {
    const key = (req.header('X-API-Key')) || req.ip || 'unknown';
    const now = Date.now();

    let state = rateLimitStore.get(key);
    if (!state) {
        state = { tokens: MAX_TOKENS, lastUpdate: now };
    } else {
        // Recover tokens based on time passed
        const elapsed = now - state.lastUpdate;
        state.tokens = Math.min(MAX_TOKENS, state.tokens + elapsed * TOKEN_RECOVERY_RATE);
        state.lastUpdate = now;
    }

    if (state.tokens < 1) {
        res.status(429).json({
            error: 'Too many requests',
            retryAfterMs: Math.ceil((1 - state.tokens) / TOKEN_RECOVERY_RATE)
        });
        return;
    }

    state.tokens -= 1;
    rateLimitStore.set(key, state);
    next();
}

/**
 * Simple API Key authentication middleware.
 */
export function apiKeyMiddleware(req: Request, res: Response, next: NextFunction) {
    // If debug mode is active and no key is required, skip
    if (process.env.SIMULATION_DEBUG_MODE === 'true' && !process.env.REQUIRE_API_KEY) {
        return next();
    }
    
    // Allow public access to status and health endpoints for debugging
    if (req.path === '/status' || req.path === '/health') {
        return next();
    }

    const apiKey = req.header('X-API-Key');
    const validKeys = (process.env.API_KEYS || 'dev-key').split(',');

    if (!apiKey || !validKeys.includes(apiKey)) {
        res.status(401).json({ error: 'Unauthorized: Invalid or missing X-API-Key' });
        return;
    }

    next();
}
