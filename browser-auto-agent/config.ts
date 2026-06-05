import dotenv from 'dotenv';
dotenv.config();

export type LLMProvider = 'openai' | 'gemini' | 'ollama' | 'openrouter';

export const config = {
    provider: (process.env.LLM_PROVIDER || 'openai') as LLMProvider,
    
    openai: {
        apiKey: process.env.OPENAI_API_KEY || 'lm-studio',
        model: process.env.OPENAI_MODEL || 'gpt-4o',
        baseUrl: process.env.OPENAI_BASE_URL || undefined,
    },
    
    gemini: {
        apiKey: process.env.GEMINI_API_KEY || '',
        model: process.env.GEMINI_MODEL || 'gemini-2.5-pro',
    },
    
    openrouter: {
        apiKey: process.env.OPENROUTER_API_KEY || '',
        model: process.env.OPENROUTER_MODEL || 'anthropic/claude-3.5-sonnet',
    },

    ollama: {
        baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434/api/chat',
        model: process.env.OLLAMA_MODEL || 'llama3.2-vision',
    }
};
