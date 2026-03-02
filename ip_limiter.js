// ##########################################################################
// # IP LIMITER
// # - Giới hạn số WebSocket connection theo IP
// ##########################################################################

export class IpLimiter {
    constructor(max = 30) {
        this.map = new Map();
        this.max = max;
    }

    allow(ip) {
        const current = this.map.get(ip) || 0;
        if (current >= this.max) return false;

        this.map.set(ip, current + 1);
        return true;
    }

    decrement(ip) {
        const current = this.map.get(ip) || 1;
        if (current <= 1) this.map.delete(ip);
        else this.map.set(ip, current - 1);
    }
}
