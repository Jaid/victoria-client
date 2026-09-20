import VictoriaClient from 'victoria-client'

const client = new VictoriaClient

client.log('running')
client.metric('stars', 5)
client.pushTrace('performance', {
  fps: 60,
  quality: 'ultra',
})
