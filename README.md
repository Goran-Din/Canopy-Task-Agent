# Task Agent — Sunset Services US

AI-powered task management agent for Sunset Services. Connects Telegram, Vikunja, ServiceM8, and Xero to automate field operations scheduling, job tracking, and reporting through a conversational interface.

## Architecture

- **app** — Node.js application: Telegram bot + API integrations + Claude AI
- **worker** — Background job processor: scheduled reports, sync jobs, notifications
- **db** — PostgreSQL 16: conversation history, job state, sync logs

## Quick Start

```bash
cp .env.example .env
# Fill in credentials in .env

docker compose up -d
```

## Project Structure

```
src/
├── bot/        # Telegram bot handlers and commands
├── api/        # External API clients (Vikunja, ServiceM8, Xero)
├── db/         # Database migrations and queries
├── workers/    # Background job logic
└── reports/    # Report generation
```
