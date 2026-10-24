# [Your Project Name]

**Status**: [In Development / Beta / Production]  
**Project record**: Reasonbook

[Brief 2-3 sentence description of what your project does and why it exists]

---

## Quick Start

```bash
# Install dependencies
[your install command]

# Setup environment
[your setup commands]

# Run development server
[your dev command]

# Run tests
[your test command]
```

---

## Project Documentation

- **Roadmap**: See `docs/roadmap.md` for project vision and sprint plan
- **Technical Architecture**: See `docs/technical_architecture.md` for system design
- **API Documentation**: [Link to your API docs if applicable]

---

## Development

### Prerequisites
- [Language] [version]
- [Database] [version]
- [Other dependencies]

### Environment Setup
```bash
# [Step-by-step setup instructions]
```

### Running Tests
```bash
# [Your test commands]
```

### Building for Production
```bash
# [Your build commands]
```

---

## Project Management with Reasonbook

This project uses Reasonbook to keep its record of decisions and the workflow selected by its active tier.

**For contributors**:
- Mission tracking, project history and session logs all live in `rbook/db/rbook.sqlite`

**For AI agents**:
- Application code guidance: See `AGENTS.md` (this project root)
- Reasonbook operations guidance: See the active `rbook/tiers/{tier}.md`
- Build session prompts: See `rbook/docs/build-session-prompt.md`

**Reasonbook operations** (via the Reasonbook MCP tools, from an agent session):
```
# View current mission status
rbook_mission(action="status")

# View sprint progress
rbook_sprint(action="show", sprintId="<id>")

# Validate system integrity
rbook_db(action="health")
```

---

## Contributing

[Your contribution guidelines]

---

## License

[Your license]

---

## Reasonbook Directory

The `rbook/` directory contains project management infrastructure:
- Mission and sprint tracking
- Context and session history
- Tier guides, templates, foundational documents, and Reasonbook documentation

**Do not write application code in `rbook/`** - it's for project management only.

See `rbook/README.md` for Reasonbook-specific documentation.
