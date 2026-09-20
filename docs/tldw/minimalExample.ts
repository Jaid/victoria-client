import VictoriaClient from 'victoria-client'

const client = new VictoriaClient

client.log('running')
client.metric('fps', 60)
client.pushTrace('click', {target: 'button'})
