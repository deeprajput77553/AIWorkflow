// src/plugins/Timer.js
// Countdown timer plugin

export default {
    name:        'timer',
    description: 'Sets a countdown timer in minutes. Params: { minutes: number }',
    schema: {
        minutes: { type: 'number', required: true, description: 'Number of minutes for the countdown' }
    },
    execute({ minutes }) {
        const mins = parseFloat(minutes);
        if (isNaN(mins) || mins <= 0) return 'x Timer: invalid minutes value.';
        const ms = mins * 60 * 1000;
        console.log(`[Plugin: Timer] > Timer set for ${mins} minute(s).`);
        setTimeout(() => {
            console.log(`\n! [Timer] > ${mins} minute(s) elapsed! Time to check in.`);
        }, ms);
        return `> Timer started for ${mins} minute(s). You'll be notified when it's up.`;
    }
};
