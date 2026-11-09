import EventListener from '../listener/listener.js'

export default class messageEvent extends EventListener {
  constructor() {
    super({ event: 'message' })
  }

  async execute(e) {
    this.plugins.deal(e)
  }
}
