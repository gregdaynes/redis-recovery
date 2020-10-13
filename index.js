import redis from 'redis'
import { promisify } from 'util'
import { EventEmitter } from 'events'
import { appendFile } from 'fs'

const eventEmitter = new EventEmitter()
const client = redis.createClient({ url: process.env.REDIS_URL })

const scanAsync = promisify(client.scan).bind(client)
const getAllAsync = promisify(client.hgetall).bind(client)
const appendFileAsync = promisify(appendFile)

// Configuration
// -------------
//
// 1. HScan arguments - follow regex command format
const scanArguments = ['MATCH', 'bull:*Volume:[0-9]*', 'COUNT', '1500']
// 2. Hash key index to use for filename
//    eg: with a hash key = 'q:one:example'
//        output file 'one.txt'
//        set filenameIndex = 1
const filenameIndex = 1
// 3. Date range to filter
const timestampRange = {
  start: new Date(1602273600000),
  end: new Date(1602278100000)
}

init()
  .on('done', end)
  .on('error', handleError)
  .on('log', console.log)
  .on('keyMatch', getData)
  .on('retrieveData', validate)
  .on('validateData', reduceData)
  .on('reduceData', writeData)

// Private

function init () {
  client.on('error', handleError)
  setImmediate(() => scan())
  return eventEmitter
}

function broadcast (key, data) {
  eventEmitter.emit(key, data)
}

function log (...msg) {
  broadcast('log', JSON.stringify({ ...msg }, null, 2))
}

function handleError (err) {
  log(err)
}

function end () {
  client.quit(() => log('closed client connection'))
}

// Recursively scan Redis for keys that match the configured scanArguments.
// Emits an event keyMatch when found, and moves to the nextCursor
// if nextCursor is 0, ends recursion
function scan (cursor = 0) {
  scanAsync(cursor, ...scanArguments)
    .then(([nextCursor, matchedKeys]) => {
      matchedKeys.forEach((key) => broadcast('keyMatch', { key }))

      // nextCursor returned from scan is a string not an integer
      if (nextCursor === '0') return broadcast('done')

      return scan(nextCursor)
    })
    .catch(err => broadcast('error', err))
}

// Listen for a `keyMatch` event and then fetch the data for the key.
// Deep parse the data to JSON and Emit event `retrieveData`
function getData ({ key }) {
  getAllAsync(key)
    .then(data => {
      try {
        return {
          ...data,
          data: JSON.parse(data.data),
          opts: JSON.parse(data.opts)
        }
      } catch (err) {
        throw new Error({ err, key, data })
      }
    })
    .then(data => broadcast('retrieveData', { key, data }))
    .catch(err => broadcast('error', err))
}

function validate ({ key, data }) {
  if (data.timestamp < timestampRange.start || data.timestamp > timestampRange.end) return
  console.log('valid date range', data.timestamp)

  broadcast('validateData', { key, data })
}

function reduceData ({ key, data }) {
  const slug = data?.data?.shop?.shop_slug
  const products = data?.data?.products?.map(product => product.id)
  const topic = data?.data?.topic

  broadcast('reduceData', {
    key,
    data: {
      slug,
      products,
      topic
    }
  })
}

function writeData ({ key, data }) {
  const filename = key.split(':')[`${filenameIndex}`]

  appendFileAsync(`${filename}.txt`, `${JSON.stringify({ key, ...data })}\n`)
    .catch((err) => broadcast('error', err))
}
