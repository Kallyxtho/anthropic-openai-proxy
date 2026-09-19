const fs = require('fs')
// Prompt agentico realistico come quello che Claude Code genera
const body = {
  model: 'x-preview-f-free',
  messages: [{
    role: 'user',
    content: 'Sei in C:\\progetto. Analizza la cartella: elenca i file, leggi quelli principali, identifica la struttura del progetto e proponi i prossimi 3 passaggi di refactoring. Usa i tool a disposizione passo per passo.'
  }],
  max_tokens: 32000,
  tools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'].map(n => ({
    type: 'function',
    function: { name: n, description: `Tool ${n}: esegui operazioni ${n} nel progetto`, parameters: { type: 'object', properties: { input: { type: 'string' } } } }
  }))
}
fs.writeFileSync('C:/Users/jacop/proxy/agent-test.json', JSON.stringify(body))
console.log('ok')
