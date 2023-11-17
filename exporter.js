const http = require('http');
const prom = require('prom-client');
const pm2 = require('pm2');
const logger = require('pino')();

const io = require('pmx');

const prefix = 'pm2';
const labels = ['id', 'name', 'instance', 'version', 'interpreter', 'node_version'];
const map = [
  ['up', 'Is the process running'],
  ['cpu', 'Process cpu usage'],
  ['memory', 'Process memory usage'],
  ['uptime', 'Process uptime'],
  ['instances', 'Process instances'],
  ['restarts', 'Process restarts'],
  ['prev_restart_delay', 'Previous restart delay']
];

const pm2c = (cmd, args = []) => new Promise((resolve, reject) => {
  pm2[cmd](args, (err, resp) => {
    if (err) return reject(err);
    return resolve(resp);
  });
});

const begin = new Date();
const metrics = () => {
  const pm = {};
  const registry = new prom.Registry();
  for (const m of map) {
    pm[m[0]] = new prom.Gauge({
      name: `${prefix}_${m[0]}`,
      help: m[1],
      labelNames: labels,
      registers: [registry]
    });
  }

  return pm2c('list')
    .then(list => {
      for (const p of list) {
        logger.debug(p, p.exec_interpreter, '>>>>>>');
        const conf = {
          id: p.pm_id,
          name: p.name,
          version: p.pm2_env.version ? p.pm2_env.version : 'N/A',
          instance: p.pm2_env.NODE_APP_INSTANCE,
          interpreter: p.pm2_env.exec_interpreter,
          node_version: p.pm2_env.node_version
        };

        const values = {
          up: p.pm2_env.status === 'online' ? 1 : 0,
          cpu: p.monit.cpu,
          memory: p.monit.memory,
          uptime: Math.round((Date.now() - p.pm2_env.pm_uptime) / 1000),
          instances: p.pm2_env.instances || 1,
          restarts: p.pm2_env.restart_time,
          prev_restart_delay: p.pm2_env.prev_restart_delay
        };

        const names = Object.keys(p.pm2_env.axm_monitor);

        // eslint-disable-next-line no-restricted-syntax
        for (const name of names) {
          try {
            let value;
            if (name === 'Loop delay') {
              value = Number.parseFloat(p.pm2_env.axm_monitor[name].value.match(/^[\d.]+/)[0]);
            } else if (/Event Loop Latency|Heap Size/.test(name)) {
              value = Number.parseFloat(p.pm2_env.axm_monitor[name].value.toString().split('m')[0]);
            } else {
              value = Number.parseFloat(p.pm2_env.axm_monitor[name].value);
            }

            if (Number.isNaN(value)) {
              logger.warn('Ignoring metric name "%s" as value "%s" is not a number', name, value);
              // eslint-disable-next-line no-continue
              continue;
            }

            const metricName = `${prefix}_${name.replace(/[^a-z\d]+/gi, '_').toLowerCase()}`;
            // pm2_event_loop_latency_p95 는 첫 45초간은 사용하지 않는다. 초반 앱 실행하면서 튄 수치가 반영되기 때문이다. 45초는 임의로 정한 수치이다.
            if (metricName === 'pm2_event_loop_latency_p95' && (Date.now() - begin.getTime()) / 1000 <= 45) {
              value = 0;
            }

            if (!pm[metricName]) {
              pm[metricName] = new prom.Gauge({
                name: metricName,
                help: name,
                labelNames: labels,
                registers: [registry]
              });
            }

            values[metricName] = value;
          } catch (error) {
            logger.error(error);
          }
        }

        // eslint-disable-next-line consistent-return
        for (const k of Object.keys(values)) {
          if (values[k] === null) continue;

          // Prometheus client Gauge will throw an error if we don't return a number
          // so we will skip this metrics value
          if (values[k] === undefined) continue;

          pm[k].set(conf, values[k]);
        }
      }

      return registry.metrics();
    })
    .catch(err => {
      logger.error(err);
    });
};

const exporter = () => {
  const server = http.createServer((request, res) => {
    switch (request.url) {
      case '/':
        return res.end('<html>PM2 metrics: <a href="/metrics">/metrics</a></html>');
      case '/metrics':
        return metrics().then(data => res.end(data));
      default:
        return res.end('404');
    }
  });

  return io.initModule({}, (err, conf) => {
    const port = conf.port || 9209;
    const host = conf.host || '0.0.0.0';

    server.listen(port, host);
    logger.info('pm2-prometheus-exporter listening at %s:%s', host, port);
  });
};

exporter();
