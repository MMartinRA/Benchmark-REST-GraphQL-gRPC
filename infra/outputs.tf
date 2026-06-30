output "rest_ip" {
  value = aws_instance.service["rest"].public_ip
}

output "graphql_ip" {
  value = aws_instance.service["graphql"].public_ip
}

output "grpc_ip" {
  value = aws_instance.service["grpc"].public_ip
}

output "ssh_key_path" {
  value = local_file.private_key.filename
}

output "ssh_examples" {
  value = {
    rest    = "ssh -i ${local_file.private_key.filename} ubuntu@${aws_instance.service["rest"].public_ip}"
    graphql = "ssh -i ${local_file.private_key.filename} ubuntu@${aws_instance.service["graphql"].public_ip}"
    grpc    = "ssh -i ${local_file.private_key.filename} ubuntu@${aws_instance.service["grpc"].public_ip}"
  }
}
