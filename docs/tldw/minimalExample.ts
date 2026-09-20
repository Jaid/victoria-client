import VictoriaClient from 'victoria-client'

const client = new VictoriaClient({
  serviceName: 'my-app',
  endpoint: 'http://localhost:4318',
})

client.log('running')
