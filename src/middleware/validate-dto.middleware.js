'use strict';

const { plainToInstance } = require('class-transformer');
const { validate }        = require('class-validator');

function validateDto(DtoClass) {
  return async function dtoValidationMiddleware(req, res, next) {
    const dtoInstance = plainToInstance(DtoClass, req.body, {
      enableImplicitConversion: true,
    });
    const errors = await validate(dtoInstance, {
      whitelist: true,
      forbidNonWhitelisted: true,
      skipMissingProperties: false,
    });
    if (errors.length > 0) {
      const formattedErrors = errors.map((err) => ({
        field: err.property,
        constraints: err.constraints ? Object.values(err.constraints) : [],
      }));
      return res.status(422).json({
        error: 'Validation Error',
        message: 'Request payload failed validation',
        errors: formattedErrors,
        timestamp: new Date().toISOString(),
      });
    }
    req.body = dtoInstance;
    next();
  };
}

module.exports = { validateDto };
