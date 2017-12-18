// @flow

const request = require('request-promise-native');
const jwt = require('jsonwebtoken');
const R = require('ramda');
const logger = require('./logger');

const parseBearerToken = R.compose(
  R.ifElse(
    splits =>
      R.length(splits) === 2 &&
      R.compose(R.toLower, R.defaultTo(''), R.head)(splits) === 'bearer',
    R.nth(1),
    R.always(null),
  ),
  R.split(' '),
  R.defaultTo(''),
);

const decodeToken = (token, secret) => {
  try {
    const decoded = jwt.verify(token, secret);
    return decoded;
  } catch (e) {
    return null;
  }
};

const notEmpty = R.compose(R.not, R.isEmpty);
const notNaN = R.compose(R.not, R.equals(NaN));

// input: coma separated string with ids // defaults to '' if null
// output: array of ids
const parseCommaSeparatedInts = R.compose(
  R.filter(R.allPass([notEmpty, notNaN])),
  R.map(strId => parseInt(strId)),
  R.split(','),
  R.defaultTo(''),
);

// rows: Result array of permissions table query
// currently only parses the projects attribute
const parsePermissions = R.compose(
  R.over(R.lensProp('customers'), parseCommaSeparatedInts),
  R.over(R.lensProp('projects'), parseCommaSeparatedInts),
  R.defaultTo({}),
);

const createAuthMiddleware = args => async (req, res, next) => {
  const { baseUri, jwtSecret, jwtAudience } = args;
  const ctx = req.app.get('context');
  const dao = ctx.dao;

  const token = parseBearerToken(req.get('Authorization'));

  if (!token) {
    res
      .status(401)
      .send({ errors: [{ message: 'Unauthorized - Bearer Token Required' }] });
    return;
  }

  try {
    const decoded = decodeToken(token, jwtSecret);

    if (decoded == null) {
      res.status(500).send({
        errors: [
          {
            message: 'Error while decoding auth token',
          },
        ],
      });
      return;
    }

    const { sshKey, role = 'none', aud } = decoded;

    if (jwtAudience && aud !== jwtAudience) {
      logger.info(`Invalid token with aud attribute: "${aud || ''}"`);
      return res.status(500).send({
        errors: [{ message: 'Auth token audience mismatch' }],
      });
    }

    // We need this, since non-admin credentials are required to have an ssh-key
    let nonAdminCreds = {};

    if (role !== 'admin') {
      const rawPermissions = await dao.getPermissions({ sshKey });

      if (rawPermissions == null) {
        res
          .status(401)
          .send({ errors: [{ message: 'Unauthorized - Unknown SSH key' }] });
        return;
      }

      const permissions = parsePermissions(rawPermissions);

      nonAdminCreds = {
        sshKey,
        permissions, // for read & write
      };
    }

    req.credentials = {
      role,
      permissions: {},
      ...nonAdminCreds,
    };

    next();
  } catch (e) {
    res
      .status(403)
      .send({ errors: [{ message: 'Forbidden - Invalid Auth Token' }] });
  }
};

module.exports = {
  createAuthMiddleware,
  parseCommaSeparatedInts,
};
