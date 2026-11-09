import EventListener from '../listener/listener.js'

export default class noticeEvent extends EventListener {
  constructor() {
    super({ event: 'notice' })
  }

  async execute(e) {
    this.plugins.deal(e)
  }
}
