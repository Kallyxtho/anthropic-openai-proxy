const fs = require('fs')
// A: contesto minimo
const a = {
  model: 'stealth/ox-alpha', max_tokens: 2000,
  messages: [
    { role: 'system', content: 'Sei un agente di coding.' },
    { role: 'user', content: 'Analizza la cartella C:\\progetto e dimmi che struttura ha. Usa i tool.' },
  ],
  tools: ['Bash', 'Read', 'Glob'].map(n => ({ type: 'function', function: { name: n, description: `Tool ${n}`, parameters: { type: 'object', properties: { input: { type: 'string' } } } } })),
}
fs.writeFileSync('C:/Users/jacop/proxy/ab-small.json', JSON.stringify(a))

// B: stesso compito, ma con ~70KB di contesto in piu (storico simulato denso)
const filler = Array.from({ length: 700 }, (_, i) => `Riga ${i}: const risultato_${i} = calcola(${i}, ${i * 2}); // logica di business modulo ${i % 7}`).join('\n')
const b = JSON.parse(JSON.stringify(a))
b.messages.splice(1, 0,
  { role: 'user', content: 'Contesto del progetto:\n' + filler },
  { role: 'assistant', content: 'Ho analizzato il contesto del progetto.' },
)
fs.writeFileSync('C:/Users/jacop/proxy/ab-big.json', JSON.stringify(b))
console.log('A:', Math.round(fs.statSync('C:/Users/jacop/proxy/ab-small.json').size / 1024), 'KB - B:', Math.round(fs.statSync('C:/Users/jacop/proxy/ab-big.json').size / 1024), 'KB')
